/**
 * The MVP backend: a copy-on-write clone of the job's directory from
 * `ctx.worktreeAlloc`, and one dsh coding agent whose own session is rooted in
 * that copy.
 *
 * The agent is created here rather than through `ctx.subagents`, because dsh
 * pins a subagent's workspace to its parent's. `SubagentStartRequest.cwd`
 * reaches only the child's working directory (`manager.resolveDirectory` →
 * `workingDirectory.set`, which appends a `working-directory/change` event);
 * the child session's immutable header keeps the *parent's* cwd
 * (`childSessionMeta`: `cwd: parentHeader.cwd`); and the sandbox uses exactly
 * that header as its `workspace-write` boundary
 * (`SandboxPolicyService.resolve`: `session?.header.cwd ?? this.workspaceRoot`).
 * A subagent child therefore cannot write in a checkout outside its parent's
 * directory, which is what a coding job has to do. A session created with
 * `meta.cwd` set to the checkout resolves the policy to the checkout by
 * construction, and {@link assertWorkspace} refuses the run if a session ever
 * reports another directory.
 *
 * The coding agent is owned by the live session that filed the issue, so the
 * job ends with its requester. The copy survives the run: `collect` reads
 * it and `dispose` removes it, so a finished change set can still be inspected
 * after the agent has gone.
 *
 * @module omd-issue-runner/backends/dsh-agent
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, joinAssistantStreamText, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  CodingAgentBackend,
  CodingAgentJob,
  Provisioned,
  RunCollection,
  RunResult,
} from '../backend.ts'
import type { WorktreeAllocation, WorktreeAllocator } from '../types.ts'

/** How the agent is started and read. */
export interface DshAgentBackendOptions {
  /** The allocator, read per call so a late mount still applies. */
  readonly allocator: () => WorktreeAllocator | undefined
  /** The agent registry, read per call for the same reason. */
  readonly agents: () => AgentRegistry | undefined
  /** The preset registry: a coding agent without its preset has no file tools. */
  readonly presets: () => { mount(ctx: unknown, id?: string): Promise<unknown> } | undefined
  /**
   * The live agent the job's coding agent is owned by.
   * @param job - the job asking; its origin decides which session that is.
   * @returns the owner, or undefined when no live session can serve as one.
   */
  readonly parent: (job: CodingAgentJob) => Agent | undefined
  /** The prompt the agent receives, already rendered from the configured template. */
  readonly prompt: (job: CodingAgentJob) => string
}

/** What one job holds while it is alive. */
interface JobState {
  readonly allocator: WorktreeAllocator
  readonly allocation: WorktreeAllocation
  /** The session the current or last run is in; replaced by every review run. */
  session?: string
}

/** One-line `git log` entry count kept for the report. */
const LOG_ENTRIES = 20

/** Ceiling on captured `git log` output. */
const LOG_MAX_BYTES = 256 * 1024

/** Deadline for that one command. */
const LOG_TIMEOUT_MS = 10_000

/**
 * Build the dsh-agent backend.
 * @param options - the services it borrows and how the agent is started.
 * @returns a backend the runner can hand jobs to.
 */
export function createDshAgentBackend(options: DshAgentBackendOptions): CodingAgentBackend {
  const states = new Map<string, JobState>()

  return {
    name: 'dsh-agent',

    async provision(job: CodingAgentJob): Promise<Provisioned> {
      const allocator = options.allocator()
      if (allocator === undefined) {
        throw new Error(
          'omd-issue-runner: the worktreeAlloc service is not mounted, so there is no isolated checkout to work in '
          + '(mount omd-worktree-alloc)',
        )
      }
      const allocation = await allocator.allocate(job.branch, job.source)
      states.set(job.id, { allocator, allocation })
      return { worktreePath: allocation.path, branch: allocation.name }
    },

    async launch(job: CodingAgentJob, provisioned: Provisioned): Promise<RunResult> {
      const state = states.get(job.id)
      if (state === undefined) {
        throw new Error(`omd-issue-runner: job "${job.id}" has no checkout; provision it before launching`)
      }
      const agents = options.agents()
      if (agents === undefined) {
        throw new Error(
          'omd-issue-runner: the agents service is not mounted, so no coding agent was started',
        )
      }
      const parent = options.parent(job)
      if (parent === undefined) {
        throw new Error(
          'omd-issue-runner: no live dsh session can own the coding agent, so no coding agent was started',
        )
      }
      const sessionId = SessionId(randomUUID())
      const route = routeOf(parent)
      if (route === undefined) {
        throw new Error(
          `omd-issue-runner: the filing session ${String(parent.session.id)} has no provider/model route, `
          + 'so the coding agent could not render its persona; no run was started',
        )
      }
      const handle = await agents.create({
        sessionId,
        parentAgent: parent,
        agentOptions: route,
        // A preset is a scope binding, not a header fact: without mount() the
        // child gets the root tool composition, where write/edit/bash are
        // absent and no coding task can be done.
        setup: async (agentCtx) => {
          const presetId = parent.session.header.agentPreset
          const presets = options.presets()
          if (presets === undefined) throw new Error('omd-issue-runner: no agent preset registry is mounted')
          await presets.mount(agentCtx, presetId)
        },
        // The session's cwd IS the sandbox's workspace boundary, so the agent
        // is created with the checkout rather than with the requester's
        // directory and moved afterwards.
        meta: {
          cwd: provisioned.worktreePath,
          // Without the preset the child gets only the root tool composition,
          // which for a coding job means no read, write or bash at all.
          ...(parent.session.header.agentPreset === undefined
            ? {}
            : { agentPreset: parent.session.header.agentPreset }),
        },
      })
      // Recorded as soon as the session exists, so the worker's feed is
      // readable while the agent is still working.
      state.session = String(sessionId)
      try {
        assertWorkspace(handle.agent, provisioned.worktreePath, job)
        await runTurn(handle.agent, options.prompt(job), job.signal)
        const events = handle.agent.session.snapshotEvents()
        const output = finalAssistantOutput(events)
        return {
          summary: output === undefined ? '' : flattenOutput(output),
          ...stopOf(events),
          childId: String(sessionId),
        }
      } finally {
        // Reaching here means the run settled one way or another; disposing the
        // handle is what stops the agent and releases its session.
        await handle.dispose()
      }
    },

    async collect(job: CodingAgentJob): Promise<RunCollection> {
      const state = states.get(job.id)
      if (state === undefined) {
        throw new Error(`omd-issue-runner: job "${job.id}" has no checkout to collect`)
      }
      const patch = await state.allocator.collect(state.allocation)
      return {
        patch,
        patchBytes: new TextEncoder().encode(patch).byteLength,
        changedFiles: changedFilesOf(patch),
      }
    },

    sessionOf(job: CodingAgentJob): string | undefined {
      return states.get(job.id)?.session
    },

    async dispose(job: CodingAgentJob): Promise<void> {
      const state = states.get(job.id)
      if (state === undefined) return
      states.delete(job.id)
      // A cancelled job keeps no work: the answer it would have carried is
      // already refused, so the checkout goes rather than piling up as debris.
      await state.allocator.release(state.allocation, { force: true })
    },
  }
}

/**
 * The model route the coding agent needs at prompt assembly. The loop reads
 * `agent.options.model` for `{{model}}` before any request waterfall runs, so a
 * child created with an empty route fails on an unresolved prompt variable.
 * A live session that picked its model later carries it in `model/selection`.
 * @param parent - the filing session's agent.
 * @returns the provider and model, or undefined when neither has one.
 */
export function routeOf(parent: Agent): { provider: string; model: string } | undefined {
  const options = parent.options
  if (typeof options.provider === 'string' && typeof options.model === 'string') {
    return { provider: options.provider, model: options.model }
  }
  const events = parent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // The model selection is a host-owned session event outside the typed
    // union, read here by its documented data shape.
    const event = events[index] as { type?: string; data?: unknown } | undefined
    if (event?.type !== 'model/selection') continue
    const data = (event.data ?? {}) as { provider?: unknown; model?: unknown }
    if (typeof data.provider === 'string' && typeof data.model === 'string') {
      return { provider: data.provider, model: data.model }
    }
  }
  return undefined
}

/**
 * Refuse a session whose sandbox boundary is not the checkout.
 *
 * The whole reason the session is created here is that `workspace-write`
 * resolves to its `cwd`; if that stops holding, every write the agent attempts
 * is denied with a sandbox marker the job never sees — a report that looks like
 * work and is not. Naming both directories is the only useful failure.
 * @param agent - the freshly created coding agent.
 * @param checkout - the allocated checkout it must be confined to.
 * @param job - the job, for the message.
 */
export function assertWorkspace(agent: Agent, checkout: string, job: CodingAgentJob): void {
  const workspace = agent.session.header.cwd
  if (workspace !== undefined && resolve(workspace) === resolve(checkout)) return
  throw new Error(
    `omd-issue-runner: the coding agent for job "${job.id}" has workspace `
    + `${JSON.stringify(workspace ?? '(none)')} instead of the checkout ${JSON.stringify(checkout)}, `
    + 'so its workspace-write policy would deny every write there; the run was not started',
  )
}

/**
 * Give the agent the issue and wait for it to reach quiescence.
 *
 * The job's signal is the runner's cancellation channel: aborting it cancels
 * the agent's turn, which is how a cancelled job stops the coding agent.
 * @param agent - the coding agent.
 * @param prompt - the rendered issue plus every review note.
 * @param signal - the job's cancellation.
 */
export async function runTurn(agent: Agent, prompt: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('the job was cancelled')
  const cancel = (): void => { agent.cancel({ kind: 'user' }) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await agent.whenIdle()
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/**
 * The run's closing output, by the rule the subagent seam uses: the last
 * non-empty assistant message, else the joined streamed text.
 * @param events - the coding agent's own log.
 * @returns the blocks, or undefined when the agent produced neither.
 */
export function finalAssistantOutput(events: readonly SessionEvent[]): readonly ContentBlock[] | undefined {
  let message: readonly ContentBlock[] | undefined
  const streamed: string[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      if (event.data.message.content.length > 0) message = event.data.message.content
      streamed.push(joinAssistantStreamText(event.data.stream))
    } else if (event.type === 'assistant/attempt') {
      streamed.push(joinAssistantStreamText(event.data.stream))
    }
  }
  if (message !== undefined) return message
  const text = streamed.join('')
  return text.length > 0 ? [{ type: 'text', text }] : undefined
}

/**
 * Why the agent's last turn ended, in the vocabulary the runner reports.
 *
 * The log is authoritative: disposal always succeeds, so a teardown cannot tell
 * failed work from finished work.
 * @param events - the coding agent's own log.
 * @returns the stop reason and, for a failed turn, its diagnostic.
 */
export function stopOf(events: readonly SessionEvent[]): Pick<RunResult, 'stopReason' | 'diagnostic'> {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'turn/end') continue
    const reason = event.data.reason
    switch (reason.kind) {
      case 'max-tokens': return { stopReason: 'max-tokens' }
      case 'aborted':
      case 'interrupted': return { stopReason: 'aborted' }
      case 'error': return { stopReason: 'error', diagnostic: reason.error.message }
      // A pre-step rejection — a hook deny, a policy plugin — declined the
      // task rather than doing it.
      case 'blocked': return { stopReason: 'refusal' }
      default: return { stopReason: 'completed' }
    }
  }
  return { stopReason: 'completed' }
}

/**
 * Repository-relative paths a patch touches.
 *
 * `git diff --binary` names both sides of every file in its header; the
 * new side is what a reviewer wants, and a rename shows the destination.
 *
 * @param patch - patch text from the allocator.
 * @returns sorted, deduplicated paths.
 */
export function changedFilesOf(patch: string): string[] {
  const files = new Set<string>()
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    const destination = match?.[2]
    if (destination !== undefined) files.add(destination)
  }
  return [...files].sort()
}


/**
 * Flatten a run's final blocks into the text a report carries.
 * @param blocks - the agent's output blocks.
 * @returns their text, with non-text blocks noted by type.
 */
export function flattenOutput(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'reasoning') continue
    else parts.push(`[${block.type}]`)
  }
  return parts.join('\n')
}
