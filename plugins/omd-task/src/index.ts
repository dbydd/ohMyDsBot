/**
 * omd-task — omp-style batch delegation: one `task` call starts every
 * `tasks[]` item as its own subagent, overlapping them up to a capacity the
 * plugin owns, then reports each outcome as a `<task-result>` envelope.
 *
 * Why a separate tool instead of the shipped `subagent` tool:
 *
 * - **Batch shape.** omp's `task` takes a shared `context` plus a list of
 *   self-contained items, so a parent writes the shared contract once. The
 *   shipped tool takes one prompt per call.
 * - **Queueing, not failing.** The subagent runtime rejects a start with
 *   `ACTIVATION_LIMIT_REACHED` once its pool is full. A batch must wait for a
 *   slot and retry, because the model cannot sensibly react to that rejection
 *   mid-batch.
 * - **One result shape.** Envelopes keep last-mile pruning honest: status,
 *   abort reason, error, and a bounded preview live in fixed sections the
 *   parent can skim.
 *
 * The agent catalog is optional. With `omd-agents` mounted, an item's `agent`
 * resolves to its instructions, model, and tool list; without it, `agent` is
 * carried through as the child's label so delegation still works and the
 * missing catalog stays an operational gap rather than a load failure.
 *
 * An `isolated` item gets its own working tree from `omd-worktree-alloc`, named
 * after the reserved child id (`omd/task/<childId>`, also the envelope's `id`).
 * When the child settles, its change set is applied to the parent checkout
 * through the allocator's serial queue and the tree is removed. A conflict
 * leaves every parent file untouched, keeps the tree, and names the files in
 * the envelope. Everything else a parent needs from delegation — steering,
 * interruption, the live roster — is the shipped subagent tool set, which this
 * package deliberately does not reimplement.
 *
 * @module omd-task
 */

import { randomUUID } from 'node:crypto'

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_FULL_OUTPUT_THRESHOLD, renderEnvelope, statusOf } from './envelope.ts'
import type { IsolationOutcome } from './envelope.ts'
import { Semaphore } from './semaphore.ts'
import type {
  AgentCatalog,
  AgentDefinition,
  IsolationResult,
  SubagentActivation,
  SubagentProvider,
  SubagentRuntime,
  SubagentStartRequest,
  WorktreeAllocation,
  WorktreeAllocator,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'omd-task'
/** The subagent seam and the tool registry are both required before this loads. */
export const inject = ['subagents', 'tools']

/** Configuration for one mounted `task` tool. */
export interface Config {
  /** `ctx.subagents` provider name the batch starts children on. */
  provider: string
  /** Model-facing tool name; every mounted instance must use a distinct name. */
  toolName: string
  /** How many of this plugin's children may run at once. */
  maxConcurrency: number
  /**
   * The subagent runtime's own child ceiling, mirrored here because the service
   * does not expose it. The runtime still enforces the real value; this copy
   * only keeps the plugin from queueing work the runtime would reject.
   */
  maxActiveSubagents: number
  /** Delay between retries after the runtime reports its pool is full. */
  retryDelayMs: number
  /**
   * How long one item may wait for a child slot before it reports failure.
   * Resident idle children keep holding their pool slots, so a full pool may
   * never free on its own and the wait has to end somewhere.
   */
  queueTimeoutMs: number
  /** Child depth cap: a non-negative integer, or `provider-managed` to send none. */
  maxDepth: number | 'provider-managed'
  /** Characters of child output shown inline before the envelope points at `agent://<id>`. */
  fullOutputThreshold: Volatile<number>
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn').description('Subagent provider the batch starts children on.'),
  toolName: z.string().default('task').description('Model-facing tool name.'),
  maxConcurrency: z.number().step(1).min(1).max(64).default(4)
    .description('How many children this tool runs at once.'),
  maxActiveSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8)
    .description('Mirror of the subagent runtime child ceiling (its shipped default is 8).'),
  retryDelayMs: z.number().step(1).min(1).max(10000).default(200)
    .description('Delay before retrying a start the runtime refused for capacity.'),
  queueTimeoutMs: z.number().step(1).min(1000).max(3600000).default(600000)
    .description('How long one item waits for a child slot before reporting failure.'),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)])
    .default('provider-managed')
    .description('Child delegation depth cap; `provider-managed` sends none.'),
  fullOutputThreshold: z.number().step(1).min(1).default(DEFAULT_FULL_OUTPUT_THRESHOLD)
    .volatile()
    .description('Characters of child output shown inline before the envelope points at the child session.'),
})

/** One batch item as the model supplied it. */
interface TaskItem {
  name?: string
  agent: string
  task: string
  isolated?: boolean
  tools?: string[]
  outputSchema?: unknown
  /**
   * Give the child its own context-notebook section. `true` names the section
   * after the child; a string names it explicitly. The child is told the
   * address and may write only there.
   */
  notebook?: boolean | string
}

/** One row of the tool's canonical result. */
interface TaskRow {
  /** Resolved display label, from `name` or derived from the agent name and position. */
  name: string
  /** Agent name the item asked for. */
  agent: string
  /** Child session id, or `not-started` when no child was published. */
  id: string
  /** Status phrase, matching the envelope's opening tag. */
  status: string
  /** Complete `<task-result>` envelope for this item. */
  envelope: string
  /** How an isolated item's changes landed; absent for a shared-directory item. */
  isolation?: { outcome: string; conflicts: string[] }
}

/** The outcome of landing one isolated run, plus where its evidence stayed. */
interface SettledIsolation {
  /** `applied`, `conflict`, or `failed`. */
  outcome: 'applied' | 'conflict' | 'failed'
  /** Repository-relative files git refused; empty unless `conflict`. */
  conflicts: string[]
  /** Isolated directory kept for inspection when the changes did not land. */
  kept?: string
  /** Why the changes did not land, or why the tree survived a landing. */
  detail?: string
}

/** One catalog-resolved child route. */
interface ChildRoute {
  /** Instructions the child should follow, when the catalog resolved the name. */
  instructions?: string
  /** Provider/model override derived from the definition's `model` field. */
  model?: { provider: string; model: string }
  /** Reasoning effort derived from the definition's `thinkingLevel`. */
  thinkingLevel?: string
  /** Tools the child should stay within, from the definition. */
  tools?: readonly string[]
}

/** Everything one item needs from the enclosing call. */
interface RunInput {
  /** Plugin context, used to resolve the catalog at call time rather than load time. */
  ctx: Context
  /** Subagent service to start children on. */
  subagents: SubagentRuntime
  /** The mounted configuration. */
  config: Config
  /** Calling agent, used as the child's parent. */
  parent: Agent
  /** Batch semaphore, shared by every item of this call. */
  semaphore: Semaphore
  /** The mounted worktree allocator, when any. */
  allocator: WorktreeAllocator | undefined
  /** Resolved numeric depth cap, absent for provider-managed delegation. */
  maxDepth: number | undefined
  /** Shared background written once for the whole batch. */
  context: string
  /** The item itself. */
  item: TaskItem
  /** Zero-based position, used only for the derived label. */
  index: number
  /** The tool call's cancellation. */
  signal: AbortSignal
}

/**
 * Register the batch `task` tool.
 *
 * @param ctx - plugin context with `subagents` and `tools` present.
 * @param config - batch capacity, provider, and child depth policy.
 */
export function apply(ctx: Context, config: Config): void {
  // `subagents` is the upstream service, read through `ctx.get` so this
  // package never redeclares its `Context` slot in a second program.
  const subagents: SubagentRuntime | undefined = ctx.get('subagents')
  if (subagents === undefined) {
    throw new Error('omd-task: requires the subagents service; mount @deepseek-ai/dsh-subagent')
  }
  const provider = subagents.getProvider(config.provider)
  if (provider === undefined) {
    throw new Error(
      `omd-task: no subagent provider named "${config.provider}" is registered `
      + `(registered: ${subagents.list().join(', ') || 'none'})`,
    )
  }
  // The description is built once, so its agent list reflects the catalog at
  // load time; routing below reads the catalog per call so a later mount still
  // applies. Without a catalog the tool stays usable.
  const catalog: AgentCatalog | undefined = ctx.get('agentCatalog')
  const semaphore = new Semaphore(config.maxConcurrency)

  const definition = defineTool({
    name: config.toolName,
    description: describe(config.toolName, catalog),
    parameters: {
      context: {
        type: 'string',
        required: true,
        description:
          'Shared background for the whole batch: goal, constraints, and any interface the tasks share. '
          + 'Written once here instead of repeated in every task.',
      },
      tasks: {
        type: 'array',
        required: true,
        description: 'One subagent per item. Every item runs concurrently, up to the batch capacity.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              description: 'CamelCase label of at most 32 characters, for addressing this child later in the call.',
            },
            agent: {
              type: 'string',
              required: true,
              description: 'Agent name. With the agent catalog mounted this selects its instructions, model, and tools.',
            },
            task: {
              type: 'string',
              required: true,
              description:
                'Self-contained instructions: target files and non-goals, the change and its interfaces, '
                + 'and the observable acceptance result.',
            },
            isolated: {
              type: 'boolean',
              description:
                'Run in a dedicated git worktree so the child keeps its own working directory. '
                + 'When the child settles its change set is applied to your checkout and the tree is removed; '
                + 'a conflict leaves your files untouched, keeps the tree, and lists the files in `<isolation>`.',
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool allow-list the child is told to stay within.',
            },
            notebook: {
              oneOf: [{ type: 'boolean' }, { type: 'string' }],
              description:
                'Give the child a section of the context notebook. `true` names it after the child; '
                + 'a string names the section. The child receives the section address and writes only there.',
            },
            outputSchema: {
              type: 'json',
              description: 'Object-rooted JSON Schema the child must satisfy to return a structured result.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                agent: { type: 'string', required: true },
                id: { type: 'string', required: true },
                status: { type: 'string', required: true },
                envelope: { type: 'string', required: true },
                isolation: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    outcome: { type: 'string', required: true },
                    conflicts: { type: 'array', items: { type: 'string' }, required: true },
                    reason: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.results.length === 0
            ? 'No tasks were dispatched.'
            : value.results.map(result => result.envelope).join('\n\n'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('task: delegation requires a calling agent (exec.agent was undefined)')
      }
      if (args.tasks.length === 0) {
        throw new Error('task: provide at least one item in `tasks` ({ agent, task })')
      }
      args.tasks.forEach((item, index) => {
        if (item.agent.trim() === '') {
          throw new Error(
            `task: item ${index + 1} is missing \`agent\`; every task names the agent that should do the work`,
          )
        }
        if (item.task.trim() === '') {
          throw new Error(
            `task: item ${index + 1} is missing \`task\`; every task needs complete, self-contained instructions`,
          )
        }
      })
      const isolated = args.tasks.some(item => item.isolated === true)
      const allocator: WorktreeAllocator | undefined = ctx.get('worktreeAlloc')
      if (isolated && allocator === undefined) {
        throw new Error(
          'task: `isolated` requires the worktree allocator from omd-worktree-alloc; '
          + 'drop the flag or mount that package',
        )
      }
      const wantsNotebook = args.tasks.some(item => item.notebook !== undefined && item.notebook !== false)
      const notes = ctx.get('contextNotes') as NotebookService | undefined
      if (wantsNotebook && notes === undefined) {
        throw new Error(
          'task: `notebook` requires the context-notebook service from omd-context-notes; '
          + 'drop the field or mount that package',
        )
      }
      assertIsolationCapable(provider, isolated, config.provider)

      // Capacity is decided once per batch: children this plugin already runs
      // must not be double-counted by a limit that shrinks as the batch starts.
      const inFlight = semaphore.active
      const free = Math.max(1, config.maxActiveSubagents - inFlight)
      semaphore.resize(Math.max(1, Math.min(config.maxConcurrency, free)))

      const maxDepth = subagents.resolveMaxDepth(config.maxDepth)
      const runs = args.tasks.map((item, index) => runOne({
        ctx,
        subagents,
        config,
        parent,
        semaphore,
        allocator,
        maxDepth,
        context: args.context,
        item,
        index,
        signal: exec.signal,
      }))
      return { results: await Promise.all(runs) }
    },
  })

  ctx.effect(() => ctx.tools.register(definition))
}

/**
 * Reject `isolated` on a provider that cannot start a child under a reserved id.
 *
 * @param provider - the resolved provider record.
 * @param isolated - whether any item asked for an isolated checkout.
 * @param name - the provider name, for the message.
 * @throws when isolation was requested but the provider cannot reserve ids.
 */
function assertIsolationCapable(provider: SubagentProvider, isolated: boolean, name: string): void {
  if (!isolated || provider.prepareContinuable !== undefined) return
  throw new Error(
    `task: provider "${name}" starts one-shot children only, so it cannot host an isolated task `
    + '(the worktree branch is named from the child id)',
  )
}

/** The slice of `ctx.contextNotes` this plugin calls. */
interface NotebookService {
  /**
   * Reserve one child's notebook section.
   * @param childSessionId - the reserved child session id.
   * @param options - parent session and section title.
   * @returns the section address and its disposer.
   */
  allocate(
    childSessionId: string,
    options?: { parentSessionId?: string; title?: string },
  ): NotebookSection
}

/** One allocated notebook section. */
interface NotebookSection {
  /** Internal address the child may write. */
  path: string
  /** Withdraw the allocation. */
  dispose: () => void
}

/**
 * Allocate the child's notebook section when the item asked for one.
 *
 * The section is keyed by the child's reserved session id, so it must exist
 * before the child's first request. A missing service fails the item instead of
 * handing the child a path nobody honours.
 *
 * @param input - the item and the caller facts the allocation needs.
 * @param label - the resolved display label, used when the field is `true`.
 * @param childId - the reserved child session id, present whenever a section was requested.
 * @returns the allocation, or undefined when the item asked for none.
 * @throws when a section was requested and cannot be allocated.
 */
function allocateNotebook(
  input: RunInput,
  label: string,
  childId: string | undefined,
): NotebookSection | undefined {
  const requested = input.item.notebook
  if (requested === undefined || requested === false) return undefined
  if (childId === undefined) {
    throw new Error('task: a notebook section needs a reserved child id')
  }
  const notes = input.ctx.get('contextNotes') as NotebookService | undefined
  if (notes === undefined) {
    throw new Error('task: `notebook` requires the context-notebook service from omd-context-notes')
  }
  const title = typeof requested === 'string' ? requested : label
  return notes.allocate(String(childId), {
    parentSessionId: String(input.parent.session.id),
    title,
  })
}

/**
 * Start one item, wait for its slot, and settle it into a result row.
 *
 * Cancellation of the enclosing call is rethrown: the caller stopped, so there
 * is nobody left to read a per-item failure. Every other failure becomes that
 * item's envelope, so one broken delegation does not discard its siblings.
 *
 * @param input - the item, the shared batch settings, and the batch semaphore.
 * @returns the result row for this item.
 */
async function runOne(input: RunInput): Promise<TaskRow> {
  const { item, signal } = input
  const fullOutputThreshold = input.config.fullOutputThreshold.get()
  const label = item.name === undefined || item.name.trim() === ''
    ? `${item.agent} #${input.index + 1}`
    : item.name.trim()
  const startedAt = Date.now()
  let release: (() => void) | undefined
  let childSession: string | undefined
  let allocation: WorktreeAllocation | undefined
  let section: NotebookSection | undefined
  try {
    release = await input.semaphore.acquire(signal)
    // A reserved child id is what the isolated tree is named after, so mint
    // it before allocation and pass the very same id to the runtime. A
    // notebook section is keyed by the same id, so it needs one too.
    const wantsNotebook = item.notebook !== undefined && item.notebook !== false
    const childId = item.isolated === true || wantsNotebook ? SessionId(randomUUID()) : undefined
    if (item.isolated === true && childId !== undefined && input.allocator !== undefined) {
      allocation = await input.allocator.allocate(
        `omd/task/${childId}`,
        await callingDirectory(input.ctx, input.parent, signal),
      )
    }
    const catalog: AgentCatalog | undefined = input.ctx.get('agentCatalog')
    const route = routeFor(catalog, item.agent)
    section = allocateNotebook(input, label, childId)
    const activation = await startWithQueue({
      subagents: input.subagents,
      provider: input.config.provider,
      retryDelayMs: input.config.retryDelayMs,
      queueTimeoutMs: input.config.queueTimeoutMs,
      signal,
      label,
      childId,
      request: {
        ...allocation === undefined ? {} : { cwd: allocation.path },
        prompt: buildPrompt(label, item, route, input.context, section?.path),
        parent: input.parent,
        ...agentOptionsOf(route),
        ...input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth },
        ...outputSchemaOf(item.outputSchema),
      },
    })
    childSession = String(activation.childId)
    const result = await activation.result
    const status = statusOf(result.stopReason)
    const isolation = await settleIsolation(input.allocator, allocation)
    return {
      name: label,
      agent: item.agent,
      id: childSession,
      status,
      ...isolation === undefined ? {} : { isolation: rowIsolation(isolation) },
      envelope: renderEnvelope({
        id: childSession,
        agent: item.agent,
        status,
        stopReason: result.stopReason,
        durationMs: Date.now() - startedAt,
        output: flattenOutput(result.output),
        ...result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic },
        ...isolation === undefined ? {} : { isolation: envelopeIsolation(isolation) },
      }, fullOutputThreshold),
    }
  } catch (error: unknown) {
    if (signal.aborted) {
      // The parent stopped: nobody will read a result, so the tree is discarded
      // rather than applied.
      await discardIsolation(input.ctx, input.allocator, allocation)
      throw error
    }
    const id = childSession ?? 'not-started'
    const status = childSession === undefined ? 'failed (not started)' : 'failed (error)'
    const isolation = await settleIsolation(input.allocator, allocation)
    return {
      name: label,
      agent: item.agent,
      id,
      status,
      ...isolation === undefined ? {} : { isolation: rowIsolation(isolation) },
      envelope: renderEnvelope({
        id,
        agent: item.agent,
        status,
        stopReason: 'error',
        durationMs: Date.now() - startedAt,
        output: '',
        diagnostic: error instanceof Error ? error.message : String(error),
        ...isolation === undefined ? {} : { isolation: envelopeIsolation(isolation) },
      }, fullOutputThreshold),
    }
  } finally {
    section?.dispose()
    release?.()
  }
}

/** The one method this plugin needs from the host's directory service. */
interface DirectoryService {
  /**
   * The calling agent's committed directory, created when it is missing.
   *
   * @param agent - the agent whose directory is wanted
   * @param signal - cancellation of the lookup
   * @returns an absolute directory
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}

/**
 * The calling agent's own directory, which is where an isolated tree belongs.
 *
 * The process working directory is the launcher's, not the session's: a parent
 * that changed directory would otherwise isolate against the wrong checkout.
 *
 * @param ctx - plugin context, read per call so a late mount still applies.
 * @param parent - the calling agent.
 * @param signal - cancellation of the lookup.
 * @returns the directory, or undefined when the host provides no such service
 *   and the allocator should read the process working directory.
 */
async function callingDirectory(ctx: Context, parent: Agent, signal: AbortSignal): Promise<string | undefined> {
  const service: DirectoryService | undefined = ctx.get('workingDirectory')
  if (service === undefined) return undefined
  return service.ensure(parent, signal)
}

/**
 * The row's isolation view: the outcome, the refused files, and why.
 *
 * @param isolation - settled isolation report.
 * @returns the canonical output fragment.
 */
function rowIsolation(isolation: SettledIsolation): { outcome: string; conflicts: string[]; reason?: string } {
  return {
    outcome: isolation.outcome,
    conflicts: isolation.conflicts,
    ...isolation.detail === undefined ? {} : { reason: isolation.detail },
  }
}

/**
 * The envelope's isolation view, which also names the directory that was kept.
 *
 * @param isolation - settled isolation report.
 * @returns the envelope fragment.
 */
function envelopeIsolation(isolation: SettledIsolation): IsolationOutcome {
  return {
    outcome: isolation.outcome,
    conflicts: isolation.conflicts,
    ...isolation.kept === undefined ? {} : { kept: isolation.kept },
    ...isolation.detail === undefined ? {} : { detail: isolation.detail },
  }
}

/**
 * Land one isolated run's changes and reclaim its tree.
 *
 * The allocator serialises applies, so siblings in one batch cannot interleave
 * their writes. A run that landed has nothing left to inspect and is removed;
 * a conflict or a failure keeps the tree, because that is the only copy of the
 * child's uncommitted work, and the sweep timer reclaims it later.
 *
 * @param allocator - the mounted allocator; absent when the item is not isolated.
 * @param allocation - the item's tree; absent when the item is not isolated.
 * @returns the outcome, or undefined when there is nothing to settle.
 */
async function settleIsolation(
  allocator: WorktreeAllocator | undefined,
  allocation: WorktreeAllocation | undefined,
): Promise<SettledIsolation | undefined> {
  if (allocator === undefined || allocation === undefined) return undefined
  let report: IsolationResult
  try {
    report = await allocator.apply(allocation)
  } catch (error: unknown) {
    return {
      outcome: 'failed',
      conflicts: [],
      kept: allocation.path,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (report.outcome !== 'applied') return { ...report, kept: allocation.path }
  try {
    await allocator.release(allocation, { force: true })
    return report
  } catch (error: unknown) {
    return {
      ...report,
      kept: allocation.path,
      detail: `the changes landed, but the isolated tree could not be removed: `
        + `${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Throw away an isolated tree whose run nobody will read.
 *
 * @param allocator - the mounted allocator, when one is present.
 * @param allocation - the item's tree, when one was created.
 */
async function discardIsolation(
  ctx: Context,
  allocator: WorktreeAllocator | undefined,
  allocation: WorktreeAllocation | undefined,
): Promise<void> {
  if (allocator === undefined || allocation === undefined) return
  try {
    await allocator.release(allocation, { force: true })
  } catch (error: unknown) {
    // A cancellation is not the place to surface a cleanup failure, but the
    // orphan is real: the allocator's sweep timer reclaims what release could not.
    ctx.logger.warn('omd-task: could not discard the isolated tree at %s: %o', allocation.path, error)
  }
}

/**
 * Start one activation, waiting out a runtime capacity rejection instead of
 * surfacing it to the model.
 *
 * @param input - provider, retry delay, signal, and the activation spec.
 * @returns the accepted activation.
 */
async function startWithQueue(input: {
  subagents: SubagentRuntime
  provider: string
  retryDelayMs: number
  queueTimeoutMs: number
  signal: AbortSignal
  label: string
  childId: SessionId | undefined
  request: Omit<SubagentStartRequest, 'label' | 'signal'>
}): Promise<SubagentActivation> {
  const deadline = Date.now() + input.queueTimeoutMs
  for (;;) {
    input.signal.throwIfAborted()
    try {
      return await input.subagents.startActivation({
        provider: input.provider,
        label: input.label,
        request: input.request,
        signal: input.signal,
        delivery: 'parent',
        ...input.childId === undefined ? {} : { childId: input.childId },
      })
    } catch (error: unknown) {
      if (errorCodeOf(error) !== 'ACTIVATION_LIMIT_REACHED') throw error
      if (Date.now() >= deadline) {
        throw new Error(
          `task: no subagent slot became free within ${Math.round(input.queueTimeoutMs / 1000)}s `
          + `(provider "${input.provider}" is at its child ceiling; resident idle children hold slots `
          + 'until they are released)',
          { cause: error },
        )
      }
      await sleep(input.retryDelayMs, input.signal)
    }
  }
}

/**
 * Read the machine-routable code from a thrown harness error.
 *
 * @param error - any thrown value.
 * @returns its `code` string, or undefined when it carries none.
 */
function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const code: unknown = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

/**
 * Wait without holding a timer past a cancellation.
 *
 * @param ms - delay length.
 * @param signal - cancellation that ends the wait early.
 */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const done = (): void => {
    clearTimeout(timer)
    signal.removeEventListener('abort', done)
    resolve()
  }
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', done, { once: true })
  return promise
}

/**
 * Resolve one item's child route from the catalog.
 *
 * @param catalog - the mounted catalog, when any.
 * @param agent - the item's agent name.
 * @returns the resolved instructions, model, and tools; empty when the catalog
 *   is absent or does not know the name.
 */
function routeFor(catalog: AgentCatalog | undefined, agent: string): ChildRoute {
  const definition: AgentDefinition | undefined = catalog?.resolve(agent)
  if (definition === undefined) return {}
  const route: ChildRoute = {}
  if (definition.instructions.trim() !== '') route.instructions = definition.instructions
  if (definition.model !== undefined) {
    // `provider/model` splits on the first separator only, because a model id
    // may itself carry slashes.
    const slash = definition.model.indexOf('/')
    if (slash > 0 && slash < definition.model.length - 1) {
      route.model = {
        provider: definition.model.slice(0, slash),
        model: definition.model.slice(slash + 1),
      }
    }
  }
  if (definition.thinkingLevel !== undefined) route.thinkingLevel = definition.thinkingLevel
  if (definition.tools !== undefined) route.tools = definition.tools
  return route
}

/**
 * Build the child's single user message: the agent's own instructions when
 * known, the shared context, the item's assignment, and its declared bounds.
 *
 * @param label - the resolved display label.
 * @param item - the batch item.
 * @param route - the catalog-resolved route.
 * @param context - the batch's shared background.
 * @param notebookPath - the child's own notebook section, when one was allocated.
 * @returns the prompt blocks for `startActivation`.
 */
function buildPrompt(
  label: string,
  item: TaskItem,
  route: ChildRoute,
  context: string,
  notebookPath?: string,
): SubagentStartRequest['prompt'] {
  const tools = item.tools ?? route.tools
  const sections: string[] = []
  if (route.instructions !== undefined) sections.push(route.instructions.trim())
  if (context.trim() !== '') sections.push('# Shared context\n\n' + context.trim())
  sections.push(`# Task\n\n${item.task.trim()}`)
  if (notebookPath !== undefined) {
    sections.push(
      '# Notebook\n\n'
      + `Your assigned notebook section is \`${notebookPath}\`. Read it to check working state and write your progress there. `
      + 'You have write permission ONLY to this assigned section address. All other notebook paths (including the parent notebook and sibling sections) are read-only.',
    )
  }
  const bounds: string[] = []
  if (tools !== undefined && tools.length > 0) {
    bounds.push(`Allowed tools (advisory): ${tools.map(tool => `\`${tool}\``).join(', ')}. Stay within these tools for this assignment.`)
  }
  bounds.push('Do not run builds, linters, formatters, or tests mid-flight; the caller runs them once afterward.')
  sections.push(`# Bounds\n\n${bounds.map(line => `- ${line}`).join('\n')}`)
  return [{
    type: 'text',
    text: `You are agent \`${item.agent}\` working on task \`${label}\`.\n\n${sections.join('\n\n')}`,
  }]
}

/**
 * Map a resolved route onto child `agentOptions`, materializing only known fields.
 *
 * @param route - the catalog-resolved route.
 * @returns the `agentOptions` fragment, empty when the route names no model.
 */
function agentOptionsOf(route: ChildRoute): { agentOptions?: SubagentStartRequest['agentOptions'] } {
  if (route.model === undefined && route.thinkingLevel === undefined) return {}
  return {
    agentOptions: {
      ...route.model === undefined ? {} : route.model,
      ...route.thinkingLevel === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.thinkingLevel) },
    },
  }
}

/**
 * Validate and forward an item's structured-output schema.
 *
 * @param schema - the model-supplied schema, when present.
 * @returns the `outputSchema` fragment.
 * @throws when the value is not an object-rooted schema.
 */
function outputSchemaOf(schema: unknown): { outputSchema?: object } {
  if (schema === undefined) return {}
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('task: `outputSchema` must be a JSON Schema object')
  }
  return { outputSchema: schema }
}

/**
 * Flatten a child's final content blocks into the plain text an envelope carries.
 *
 * @param blocks - the child's output blocks.
 * @returns their text, with non-text blocks noted by type.
 */
function flattenOutput(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'reasoning') continue
    else parts.push(`[${block.type}]`)
  }
  return parts.join('\n')
}

/**
 * Build the tool description, listing catalog agents when they are known.
 *
 * The list is captured at registration because a tool definition's description
 * is fixed; `omd-agents` also renders the live catalog into the system prompt,
 * which stays correct if the catalog changes after this plugin loads.
 *
 * @param toolName - the mounted tool name.
 * @param catalog - the mounted catalog, when any.
 * @returns the model-facing description.
 */
function describe(toolName: string, catalog: AgentCatalog | undefined): string {
  const agents = catalog?.list() ?? []
  const lines = [
    'Run every `tasks[]` item as its own subagent, concurrently up to the batch capacity.',
    'Each item reports back as one `<task-result>` envelope: status, abort reason, error, and a bounded preview.',
    '',
    '# Delegation',
    'Use the most specific agent. Prefer one agent to investigate and edit rather than a pair.',
    'Shared edits need one integration owner; set the interfaces in `context` so siblings agree on them.',
    'Every task must skip builds, linters, formatters, and tests mid-flight; run them once afterward.',
    '',
    '# Inputs',
    '`name`: CamelCase, at most 32 characters, used to address this child in the call.',
    '`agent`: catalog agent name; it selects the child instructions, model, and tool list.',
    '`task`: self-contained instructions.',
    '`isolated`: run in a dedicated working tree; the change set lands in your checkout when the child settles.',
    '`tools`: tool allow-list the child is told to stay within.',
    '`notebook`: give the child its own context-notebook section; it receives the address and writes only there.',
    '`outputSchema`: object-rooted JSON Schema for the child structured result.',
    '',
    '# Isolation',
    'An isolated item reports `<isolation outcome="applied|conflict|failed">`.',
    '`conflict` names the files git refused and leaves your files untouched; the tree stays at `kept` so nothing is lost.',
    'Nothing is written unless the whole change set applies, so a conflicted item is read and re-applied, not merged by hand.',
    '',
    '# Format',
    '`context`: shared goal and contract interfaces, written once, never repeated per task.',
    '`task`: `# Target` files and non-goals, `# Change` steps and APIs, `# Acceptance` observable result.',
    '',
    '# Available agents',
  ]
  if (agents.length > 0) {
    for (const agent of agents) lines.push(`- \`${agent.name}\`: ${agent.description}`)
  } else {
    lines.push(
      'No agent catalog is mounted, so `agent` is passed through as the child label. '
      + 'Mount omd-agents to select instructions, model, and tools per agent name.',
    )
  }
  lines.push('', `Items beyond this \`${toolName}\` call's capacity wait for a slot instead of failing.`)
  return lines.join('\n')
}
