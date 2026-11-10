/**
 * `omd-issue-runner` — the host half of issue-driven coding.
 *
 * A bot is the organizer, not a coding agent: its tools are conversation-sized.
 * Real work leaves the session as an **issue**, comes back as a **PR**. This
 * plugin is the participant that holds the other end of that exchange. It joins
 * the process's Onlyne network as one node with no session of its own
 * (`ctx.onlyne.createNode`), and it answers three delivery kinds:
 *
 * - `issue` — cut an isolated checkout, start a full dsh coding agent in it with
 *   the issue as the prompt, and answer in the same thread with `pr` or `failed`.
 * - `review` — the thread already has a job that still holds its checkout, so the
 *   note becomes a follow-up run in that same checkout.
 * - `close` — the worker named in `meta.worker` is reclaimed: the run is
 *   stopped, the checkout released and the machine destroyed, and the thread
 *   gets a `closed` answer saying so.
 *
 * The work itself is a {@link CodingAgentBackend}. The shipped one
 * (`backends/dsh-agent.ts`) is deliberately the cheap end: a worktree from
 * `omd-worktree-alloc` and one dsh agent whose own session is rooted in it. A
 * container or a remote coding service is another implementation of that
 * interface, nothing here changes.
 *
 * A finished run is read before it is reported: with `ctx.judgment` mounted, one
 * choice question decides whether the agent accomplished the issue, refused it
 * or did part of it, and a refusal answers `failed` instead of `pr`.
 *
 * A settled worker is not kept forever, because nobody remembers to close one:
 * it reclaims itself after `settleReclaimMs` through the same path `close`
 * takes, and a `review` or an explicit `close` inside that window cancels the
 * countdown. Its run stays readable either way: the coding-agent session id
 * rides on the worker record, and `onlyne://runner/issue/<workerId>/events`
 * serves that session's log — from the live agent while it runs, from
 * `ctx.sessionPersistence` after it is gone.
 *
 * Not in this slice: applying the patch back to the main checkout, and any
 * surface that shows the job list to a human — the `ctx.issueRunner` service is
 * what such a surface would read.
 *
 * @module omd-issue-runner
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Entry, MsgInput, NodeId, Runtime } from '@onlyne/lib'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_ISSUE_PROMPT, renderIssuePrompt, taskText } from './backend.ts'
import type { CodingAgentJob } from './backend.ts'
import { createDshAgentBackend } from './backends/dsh-agent.ts'
import { createVmAgentBackend } from './backends/vm-agent.ts'
import { createComputeControl } from './compute.ts'
import { readSessionLog } from './events.ts'
import { createJobs, type JobService } from './jobs.ts'
import type {
  ComputeControl,
  DirectoryService,
  IssueJudge,
  IssueRunnerService,
  OnlyneService,
  RunnerReply,
} from './types.ts'
import type { BotNode } from 'omd-onlyne/node'

export type {
  CodingAgentBackend,
  CodingAgentJob,
  Provisioned,
  RunCollection,
  RunResult,
} from './backend.ts'
export type { JobService, JobSettings } from './jobs.ts'
export type {
  IssueJobState,
  IssueJobView,
  IssueRunnerService,
  IssueSubmitInput,
  RunnerReply,
} from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-issue-runner'

/** The in-process Onlyne binding is the whole reason this plugin exists. */
export const inject = ['onlyne']

/** Node id prefix this deployment uses for the sessions that file issues. */
const AGENT_NODE_PREFIX = 'urn:onlyne:agent:'

/** The kind that starts a job. */
const ISSUE_KIND = 'issue'

/** The kind that feeds an existing job. */
const REVIEW_KIND = 'review'

/** The kind that reclaims an existing worker. */
const CLOSE_KIND = 'close'

/** Name and fixed order of the prompt section that teaches the msg surface. */
const GUIDANCE_SECTION = 'omd-issue-runner:filing'
const GUIDANCE_ORDER = 151

/** Deployment settings for the runner. */
export interface Config {
  /** Mount the runner node and start answering issues. Off leaves the profile untouched. */
  enabled: boolean
  /** Node id the runner answers as; a session addresses this to file an issue. */
  runnerNodeId: string
  /** Jobs allowed to run at once. Additional issues wait in the queue; none is refused. */
  maxConcurrent: number
  /** Branch prefix; the job id is appended, so `issue/3f2a1b9c`. */
  branchPrefix: string
  /** Prompt the coding agent receives. `{{issue}}`, `{{thread}}` and `{{branch}}` are replaced. */
  issuePrompt: string
  /** Patch size, in bytes, still inlined in the `pr` answer; a larger change set is named, not inlined. */
  maxPatchBytes: number
  /** Where a run's commands execute: the host, or an isolated Linux machine. */
  backend: 'dsh-agent' | 'vm'
  /** Machine-name prefix for the `vm` backend; the job id is appended. */
  machinePrefix: string
  /** Guest path a job's workspace is mounted at under the `vm` backend. */
  guestWorkspacePath: string
  /** Node id of the compute manager a `vm` job's machine is leased from. */
  computeNodeId: string
  /** Image a leased machine runs; sent as OECP v1's `container.image`. */
  computeImage: string
  /** Lease window asked for, in milliseconds; the heartbeat renews at half of it. */
  computeTtlMs: number
  /** How long one lease ask waits for the manager's answer, in milliseconds. */
  computeTimeoutMs: number
  /** Deadline, in milliseconds, for one command the coding agent runs in the machine. */
  bashTimeoutMs: number
  /**
   * How long a settled worker is kept before it reclaims itself, in
   * milliseconds. `0` never reclaims automatically: the worker waits for a
   * `close`. A worker whose change set was too large to inline is never
   * reclaimed automatically either — that checkout is the only copy of it.
   */
  settleReclaimMs: number
  /** Whether a finished run is judged before it is reported; off reports the agent's own word. */
  judgeResults: boolean
  /** Judgement confidence at or above which the label is acted on. */
  confidenceFloor: number
}

/** Schemastery configuration for the plugin entry. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true)
    .description('Mount the runner Onlyne node and answer issues with a coding agent run.'),
  runnerNodeId: z.string().default('urn:onlyne:agent:issue-runner')
    .description('Node id this runner answers as. A session sends an issue here with delivery_kind "issue".'),
  maxConcurrent: z.natural().min(1).default(2)
    .description('Coding agents allowed to run at once. Beyond this an issue is queued, never refused.'),
  branchPrefix: z.string().default('issue/')
    .description('Prefix of the isolated branch name; the job id follows it.'),
  issuePrompt: z.string().default(DEFAULT_ISSUE_PROMPT)
    .description('Prompt template for the coding agent: {{issue}}, {{thread}} and {{branch}} are substituted.'),
  maxPatchBytes: z.natural().min(0).default(1_048_576)
    .description('Largest patch, in bytes, still included in the answer. A bigger change set is not inlined: the answer says the patch is omitted and names the branch it is on.'),
  backend: z.union(['dsh-agent', 'vm'] as const).default('dsh-agent')
    .description('"dsh-agent" runs commands on the host in a copy-on-write directory; "vm" runs them in an isolated ARM64 Linux machine that mounts that directory and offers a watchable desktop.'),
  machinePrefix: z.string().default('omd-sandbox-issue-')
    .description('Machine-name prefix under the "vm" backend. The job id follows it, so `vm://<prefix><id>` reaches one run\'s machine.'),
  guestWorkspacePath: z.string().default('/workspace')
    .description('Guest path the job workspace is mounted at, under the "vm" backend.'),
  computeNodeId: z.string().default('urn:onlyne:agent:compute')
    .description('Node id the "vm" backend leases machines from. An unknown node means no manager is reachable, and the machine is started directly instead.'),
  computeImage: z.string().default('debian:12')
    .description('Image a leased machine runs, as OECP v1\'s container.image. The provider substitutes its own default for a name it does not carry.'),
  computeTtlMs: z.natural().min(1000).default(21_600_000)
    .description('Lease window asked for, in milliseconds. The runner renews at half of it, so a job outlives its first window; 6 h by default.'),
  computeTimeoutMs: z.natural().min(1000).default(180_000)
    .description('How long one lease ask waits for the compute manager\'s answer, in milliseconds. A machine that has to be created from scratch takes about a minute.'),
  bashTimeoutMs: z.natural().min(1000).default(600_000)
    .description('Deadline for one command the coding agent runs inside the machine, in milliseconds.'),
  settleReclaimMs: z.natural().min(0).default(43_200_000)
    .description('How long a settled worker is kept before it reclaims itself — run stopped, checkout released, machine destroyed — in milliseconds; 12 h by default. A review or an explicit close within the window cancels it. A worker whose change set was larger than maxPatchBytes is never reclaimed automatically, because the checkout is the only copy of that work. 0 keeps every worker until someone closes it.'),
  judgeResults: z.boolean().default(true)
    .description('Ask the decision-model judge whether a finished run accomplished the issue, refused it or did part of it. Off reports the agent\'s own stop reason and says the result was not judged.'),
  confidenceFloor: z.number().min(0).max(1).default(0.5)
    .description('Lowest judgement confidence that changes the answer. Below it the run is reported unjudged, with the judge\'s own reading named.'),
})

/** What the node's runtime needs to turn one entry into work. */
export interface RunnerRuntimeOptions {
  readonly nodeId: NodeId
  readonly jobs: JobService
  /**
   * The lease control plane. A `compute` entry is the manager answering an ask
   * this runner made, so it settles that ask instead of becoming a job.
   */
  readonly compute?: ComputeControl
  /**
   * Resolves the checkout an issue's session works in.
   * Absent means the process working directory, which the allocation validates.
   */
  readonly source?: (requester: NodeId) => Promise<string | undefined>
}

/**
 * Build the runtime this node delivers into.
 *
 * `inject` must return quickly: it is called from the Onlyne maintenance loop,
 * and a run taking minutes inside it would delay every later entry — including
 * the review that belongs to that very run. So each kind only records what it
 * wants and returns; the queue and the coding agent run beside the loop.
 *
 * @param options - context, identity and the coordinator.
 * @returns the runtime the node was created with.
 */
export function createRuntime(options: RunnerRuntimeOptions): Runtime {
  const { nodeId, jobs, compute, source } = options
  return {
    // Every plan this process negotiates is an in-process append or push;
    // nothing here needs a host that can hold a remote await.
    supports: async () => true,
    async inject(entry: Entry, context: string | undefined) {
      const kind = entry.message.delivery_kind
      // The manager answers an ask and refuses with the same `failed` kind a
      // job's own failure carries, so the answer is claimed by author first:
      // refusing it below would answer the answer.
      if (compute?.settle(entry) === true) { /* a lease answer, not work */ }
      else if (kind === ISSUE_KIND) void acceptIssue(jobs, source, entry)
      else if (kind === REVIEW_KIND) jobs.acceptReview(entry)
      else if (kind === CLOSE_KIND) jobs.acceptClose(entry)
      else jobs.refuseKind(entry)
      return { context: context ?? nodeId, consumed: true, outcome: 'queued' }
    },
    // In-process peers wake this node through the transport; a second
    // notification surface has nothing to do.
    notify: () => {},
  }
}

/**
 * Start a job for one `issue` entry, from the checkout its session works in.
 *
 * An issue may name its checkout in `meta.checkout`: a Bot team's workspace is
 * often not a Git repository, while the project it files issues about is. The
 * allocator validates the path, so a bad name fails loudly rather than being
 * replaced by a guess. Otherwise the session's working directory decides.
 *
 * The directory lookup is awaited outside `inject`, which is why this is a
 * floating call: the runner node has to stay free while the host prepares it.
 * @param ctx - plugin context, read per call so a late mount applies.
 * @param jobs - the coordinator.
 * @param entry - the admitted issue.
 */
async function acceptIssue(
  jobs: JobService,
  resolveSource: ((requester: NodeId) => Promise<string | undefined>) | undefined,
  entry: Entry,
): Promise<void> {
  const named = checkoutIn(entry)
  const source = named ?? (resolveSource === undefined ? undefined : await resolveSource(entry.authenticated_author))
  jobs.acceptIssue(entry, source)
}

/**
 * The absolute checkout path an issue names in `meta.checkout`, if it has one.
 * @param entry - the admitted issue.
 * @returns the path, or undefined when the issue names none.
 */
function checkoutIn(entry: Entry): string | undefined {
  const value = entry.message.meta?.data?.checkout
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The checkout an issue's session works in.
 *
 * An issue filed by a session is about that session's project, so the tree is
 * cut from its committed directory. Anything else — a node that is not a
 * session, a host without a directory service — falls back to the process
 * working directory, which the allocation then validates.
 *
 * @param ctx - plugin context.
 * @param requester - node that filed the issue.
 * @returns the absolute directory, or undefined when the session is unknown.
 */
async function checkoutOf(ctx: Context, requester: NodeId): Promise<string | undefined> {
  const agents: AgentRegistry | undefined = ctx.get('agents')
  const directory: DirectoryService | undefined = ctx.get('workingDirectory')
  if (agents === undefined || directory === undefined) return undefined
  const session = requesterSession(requester)
  const agent = session === undefined ? undefined : agents.get(session)
  if (agent === undefined) return undefined
  try {
    return await directory.ensure(agent)
  } catch (error) {
    // The fallback is the process directory, not a silent skip: say which
    // session's directory could not be read, or the tree would be cut from a
    // checkout nobody chose.
    ctx.logger.warn(
      `omd-issue-runner: session ${String(agent.session.id)} has no usable directory: ${reasonOf(error)}`,
    )
    return undefined
  }
}

/**
 * The live agent a job's coding agent is owned by.
 *
 * The session that filed the issue is the honest owner: the job ends with it,
 * and `cancel` at the runner is not the only way a requester can stop work it
 * asked for. A runner node has no session of its own, which is why this lookup
 * exists at all.
 * @param ctx - plugin context.
 * @param job - the job being launched.
 * @returns the owner, or undefined when no live session can serve.
 */
function parentFor(ctx: Context, job: CodingAgentJob): Agent | undefined {
  const agents: AgentRegistry | undefined = ctx.get('agents')
  if (agents === undefined) return undefined
  const session = job.requester === undefined ? undefined : requesterSession(job.requester)
  const filed = session === undefined ? undefined : agents.get(session)
  return filed ?? agents.roots()[0]
}

/**
 * The session id inside a session's node id.
 * @param node - a node id following `urn:onlyne:agent:<sessionId>`.
 * @returns the id, or undefined for another node.
 */
function requesterSession(node: string): SessionId | undefined {
  if (!node.startsWith(AGENT_NODE_PREFIX)) return undefined
  const id = node.slice(AGENT_NODE_PREFIX.length)
  return id === '' ? undefined : SessionId(id)
}

/**
 * Send one answer into its thread.
 *
 * The thread is the one the issue opened; the runner writes into it as a
 * participant, and `in_reply_to` is what raises attention at the addressee's
 * node, because a send that only names a thread notifies nobody.
 * @param node - the runner node.
 * @param reply - kind, body, addressee and card data.
 */
export async function sendReply(node: BotNode, reply: RunnerReply): Promise<void> {
  if (typeof node.ensurePaired === 'function') {
    await node.ensurePaired(reply.to)
  }
  const message: MsgInput = {
    delivery_kind: reply.kind,
    msg: reply.body,
    meta: {
      to: reply.to,
      thread: { owner: reply.thread.owner, id: reply.thread.id },
      ...reply.inReplyTo === undefined
        ? {}
        : { in_reply_to: { sender: reply.inReplyTo.sender, id: reply.inReplyTo.id } },
      // Beside the addressing keys, not under a nested object: the library
      // stores the whole input meta as the message's `meta.data`, so a card
      // reads `meta.data.worktree` rather than `meta.data.data.worktree`.
      ...reply.data,
    },
  }
  await node.node.client.msg(message)
}

/**
 * Mount the runner node and publish its service.
 * @param ctx - plugin context with `onlyne` present.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const service: OnlyneService = ctx.onlyne

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: GUIDANCE_SECTION,
      order: GUIDANCE_ORDER,
      interpolate: false,
      text: [
        '# Coding jobs over Onlyne',
        '',
        `An issue runner listens at the Onlyne node \`${config.runnerNodeId}\`. `
        + 'File a coding job with the `msg` tool: delivery_kind "issue", the task as the body, '
        + '`meta.to` set to the runner node id, and the unit of work in `meta.work` '
        + '(`{ "unit": "<ticket id>" }`, with an optional `attempt`). That unit is the job\'s identity: '
        + 'filing the same unit again — from any thread — joins the worker that already holds it and '
        + 'never starts a second machine; the answer names that worker. The runner clones the directory '
        + 'into an isolated copy, runs a full coding agent on the task, and its answer (`pr`, `failed` or '
        + '`note`) arrives by itself as a new message — never poll after sending. A later `msg` '
        + 'with delivery_kind "review" feeds the still-open job: send it in the same thread, or name '
        + '`meta.worker` or `meta.work.unit` from another one. A review may carry `meta.verdict`: '
        + '"approve" reclaims the worker and answers "closed"; "reject" (or no verdict) runs the agent '
        + 'again with the note. The `pr` answer carries the worker address '
        + '`onlyne://runner/issue/<workerId>`, which identifies the checkout that continues — the machine '
        + 'is named separately, so a machine rename never moves the worker. Every live worker, with its '
        + 'machine, state and coding-agent `session`, is listed at `onlyne://runner/workers`; the run itself '
        + 'reads at `onlyne://runner/issue/<workerId>/events`. '
        // The retain window is configuration, so the sentence follows it.
        + (config.settleReclaimMs > 0
          ? `A settled worker is kept ${retentionOf(config.settleReclaimMs)} and then reclaims itself, `
            + 'so stop watching it without closing it; one whose change set was too large to inline is '
            + 'never reclaimed that way. '
          : 'A settled worker is kept until someone closes it. ')
        + 'When that worker is finished with — its change set applied or dropped — send delivery_kind '
        + '"close" with `meta.worker` '
        + 'set to it: the checkout and the machine are destroyed and the answer is "closed". Peer node ids: '
        + 'read `onlyne://directory`. No repository is required; to work on another project, name '
        + 'its directory in `meta.checkout` (absolute path), which the allocation validates.',
      ].join('\n'),
    })
  }

  const prompt = (job: CodingAgentJob): string => renderIssuePrompt(config.issuePrompt, {
    issue: taskText(job),
    thread: job.thread ?? 'local',
    branch: job.branch,
  })
  const shared = {
    allocator: () => ctx.get('worktreeAlloc'),
    agents: () => ctx.get('agents'),
    presets: () => ctx.get('agentPresets'),
    parent: (job: CodingAgentJob) => parentFor(ctx, job),
    prompt,
  }
  let node: BotNode | undefined
  // The manager is a peer, not a service: the runner asks it over its own node,
  // which is why the client reads `node` per call instead of taking it here.
  const compute = createComputeControl({
    managerId: config.computeNodeId,
    node: () => node,
    timeoutMs: config.computeTimeoutMs,
    log: message => ctx.logger.warn(message),
  })
  const backend = config.backend === 'vm'
    ? createVmAgentBackend({
      ...shared,
      vm: () => ctx.get('sandboxVm'),
      compute: () => compute,
      image: config.computeImage,
      leaseTtlMs: config.computeTtlMs,
      // The machine is named after the worker, never the worker after the
      // machine: renaming a machine changes nothing a caller addresses.
      machineName: job => `${config.machinePrefix}${job.workerId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`,
      guestWorkspacePath: config.guestWorkspacePath,
      bashTimeoutMs: config.bashTimeoutMs,
      maxOutputChars: 200_000,
      log: message => ctx.logger.warn(message),
    })
    : createDshAgentBackend(shared)

  const jobs = createJobs(
    {
      maxConcurrent: config.maxConcurrent,
      branchPrefix: config.branchPrefix,
      maxPatchBytes: config.maxPatchBytes,
      confidenceFloor: config.confidenceFloor,
      judgeResults: config.judgeResults,
      settleReclaimMs: config.settleReclaimMs,
    },
    {
      backend,
      send: async reply => {
        if (node === undefined) {
          throw new Error('omd-issue-runner: the runner node is not up yet')
        }
        await sendReply(node, reply)
      },
      log: message => ctx.logger.warn(message),
      judgment: () => ctx.get('judgment') as IssueJudge | undefined,
      // A worker's feed: the live agent while the run is in this process, the
      // stored log afterwards, which is what keeps a settled worker readable.
      readSession: sessionId => readSessionLog({
        agents: () => ctx.get('agents'),
        persistence: () => ctx.get('sessionPersistence'),
      }, sessionId),
      reclaimOrphan: async worker => {
        const id = worker.match(/^onlyne:\/\/runner\/issue\/([A-Za-z0-9][A-Za-z0-9._~-]*)$/u)?.[1]
        if (id === undefined) return undefined
        const machine = `${config.machinePrefix}${id.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`
        // The lease table is the manager's, so a machine it holds is destroyed
        // through it; one it does not hold is this host's debris and is swept here.
        if (await compute.destroy(machine) === 'destroyed') return { machine }
        const vm = ctx.get('sandboxVm')
        if (vm === undefined) return undefined
        const machines = await vm.list()
        if (!machines.some((item: { name: string }) => item.name === machine)) return undefined
        await vm.dispose(machine)
        return { machine }
      },
    },
  )

  const runner = service.createNode({
    nodeId: config.runnerNodeId,
    runtime: createRuntime({
      nodeId: config.runnerNodeId,
      jobs,
      compute,
      source: requester => checkoutOf(ctx, requester),
    }),
  })
  runner.then(created => { node = created }, error => {
    ctx.logger.warn('omd-issue-runner: the runner node could not start: %o', error)
  })

  const published: IssueRunnerService = {
    submit: input => jobs.submit(input),
    list: () => jobs.list(),
    workers: () => jobs.workers(),
    cancel: jobId => jobs.cancel(jobId),
    close: jobId => jobs.close(jobId),
  }
  ctx.provide('issueRunner', published)

  // The catalog is also a process-level read: `omd-onlyne` serves
  // `onlyne://runner/workers`, `onlyne://runner/issue/<workerId>` and that
  // worker's `/events` from it, so a UI does not have to hold this plugin's
  // service to watch a run.
  globalThis.__onlyneRunnerCatalog = {
    workers: () => jobs.workers(),
    readEvents: worker => jobs.readEvents(worker),
  }

  ctx.effect(() => () => {
    globalThis.__onlyneRunnerCatalog = undefined
    node = undefined
    void runner.then(created => created.dispose(), () => undefined)
    // Worktrees outlive the process otherwise; the allocator's own sweep is the
    // backstop for the case where this teardown never runs.
    void jobs.shutdown()
  }, 'omd-issue-runner: node and jobs')

  ctx.logger.info(
    `omd-issue-runner: listening as ${config.runnerNodeId} on backend "${backend.name}" `
    + `(maxConcurrent ${String(config.maxConcurrent)})`,
  )
}

/** One line of an arbitrary thrown value. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message
  return String(error)
}

/**
 * A retain window as the prompt states it: hours from an hour up, minutes below.
 * @param ms - the window, in milliseconds.
 * @returns the window in one unit, so the prompt reads "12 h" rather than "720 min".
 */
function retentionOf(ms: number): string {
  if (ms < 3_600_000) return `${String(Math.round(ms / 60_000))} min`
  const hours = ms / 3_600_000
  return `${Number.isInteger(hours) ? String(hours) : hours.toFixed(1)} h`
}
