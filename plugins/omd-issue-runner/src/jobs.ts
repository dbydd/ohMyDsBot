/**
 * The job coordinator: what one Onlyne entry turns into, and where the answer
 * goes.
 *
 * A job owns a checkout, a queue slot and a thread. `issue` starts one,
 * `review` adds a note to the job that already holds the thread and runs the
 * agent again, `close` reclaims a worker — its checkout and the machine it ran
 * in — and anything else gets told what this runner accepts. Completion and
 * failure both answer in the same thread: `pr` with the branch, the worktree,
 * the changed files and the patch, or `failed` with the reason.
 *
 * Between the run and the answer sits the judge: a settled turn is not proof of
 * finished work, so a refusal the agent wrote in prose answers `failed` even
 * though its turn completed.
 *
 * Concurrency is a queue, not a refusal: past `maxConcurrent` a job waits for a
 * slot. Nothing here awaits a coding agent inside `inject`; the Onlyne
 * maintenance loop must stay free to deliver the next entry, and the review
 * that arrives while a run is going is exactly the case that depends on it.
 *
 * @module omd-issue-runner/jobs
 */

import { randomUUID } from 'node:crypto'
import type { Entry, Json, MessageRef, NodeId, ThreadRef } from '@onlyne/lib'
import type { CodingAgentBackend, CodingAgentJob, Provisioned, RunCollection, RunResult } from './backend.ts'
import { summarizeSession } from './events.ts'
import {
  workJson,
  type ChoiceVerdict,
  type IssueJobState,
  type IssueJobView,
  type IssueJudge,
  type IssueRunnerService,
  type IssueSubmitInput,
  type RunnerReply,
  type WorkerEventsResult,
  type WorkerRecord,
  type WorkRef,
} from './types.ts'

/** What the coordinator needs from the plugin configuration. */
export interface JobSettings {
  /** Jobs allowed to run at once; the rest wait in the queue. */
  readonly maxConcurrent: number
  /** Branch prefix; the job id follows it. */
  readonly branchPrefix: string
  /** Patch size, in bytes, still worth inlining in the `pr` answer. */
  readonly maxPatchBytes: number
  /** A judgement below this confidence is discarded and the run reported as unjudged. */
  readonly confidenceFloor: number
  /** Whether the judge is asked about a finished run at all. */
  readonly judgeResults: boolean
  /**
   * How long a settled worker is kept before it reclaims itself, in
   * milliseconds. `0` keeps it until a caller closes it, and a worker whose
   * change set was too large to inline is never reclaimed this way.
   */
  readonly settleReclaimMs: number
}

/** How the coordinator reaches the outside world. */
export interface JobPorts {
  readonly backend: CodingAgentBackend
  /** Send one answer into its thread. */
  readonly send: (reply: RunnerReply) => Promise<void>
  /** Where a broken job, a refused request and a failed send are reported. */
  readonly log: (message: string) => void
  /**
   * The decision-model judge, read per run so a late mount applies.
   * Absent means every finished run is reported with its own stop reason.
   */
  readonly judgment?: () => IssueJudge | undefined
  /**
   * Destroy the machine a worker address names when no job state remains in
   * this process, which is what a restart leaves behind.
   */
  readonly reclaimOrphan?: (worker: string) => Promise<{ machine: string } | undefined>
  /**
   * Read one coding-agent session's records, live or from its stored log.
   * Absent means this host has no session log to read, and a feed read answers
   * with that reason instead of an empty feed.
   */
  readonly readSession?: (sessionId: string) => Promise<readonly unknown[] | undefined>
}

/** One job, as the coordinator keeps it. */
interface Job {
  readonly id: string
  /**
   * The worker's identity, which is what `onlyne://runner/issue/<workerId>`
   * names. Separate from the machine name on purpose: a machine is a provider
   * label, and renaming one must not move the worker.
   */
  readonly workerId: string
  readonly title: string
  readonly issue: string
  readonly source: string
  /** The unit of work this job is, when the issue named one. */
  readonly workUnit?: string
  /** The whole work reference, as the issue sent it. */
  readonly work?: WorkRef
  /** Branch requested at submission; replaced by the allocator's own name once provisioned. */
  branch: string
  readonly controller: AbortController
  /** Notes not yet handed to a run. */
  readonly notes: string[]
  /** Notes every later run's prompt must carry, oldest first. */
  readonly delivered: string[]
  state: IssueJobState
  thread?: ThreadRef
  requester?: NodeId
  inReplyTo?: MessageRef
  /**
   * Everyone who receives this job's answers, primary thread first. A review
   * from another thread adds one, so an answer reaches the thread that asked
   * as well as the one the job started in.
   */
  readonly readers: Reader[]
  provisioned?: Provisioned
  /** The lease the machine runs under, once provisioned. */
  leaseId?: string
  /** The machine's own desktop entry, once provisioned. */
  desktopUrl?: string
  last?: RunResult
  /**
   * The coding-agent session the latest run was in. Kept after the run, so the
   * worker's feed stays readable once the agent is gone.
   */
  session?: string
  collection?: RunCollection
  failure?: string
  /** The queue turn this job is running in, while one is; `close` waits on it. */
  running?: Promise<void>
  /** The one release of this job's checkout and machine; `close` and `cancel` share it. */
  disposal?: Promise<void>
  /** Epoch milliseconds the automatic reclaim fires at, while one is scheduled. */
  reclaimAt?: number
  /** The scheduled reclaim; `close`, `cancel` and a review drop it. */
  reclaimTimer?: NodeJS.Timeout
  /** Epoch milliseconds the job was created at. */
  readonly startedAt: number
  /** Epoch milliseconds of the last state change. */
  updatedAt: number
}

/** One thread that reads a job's answers, and who to address there. */
interface Reader {
  readonly thread: ThreadRef
  requester: NodeId
  inReplyTo?: MessageRef
}

/** The coordinator, as the plugin entry consumes it. */
export interface JobService extends IssueRunnerService {
  /**
   * An `issue` entry: start a job and answer in that thread.
   * @param entry - the admitted message.
   * @param source - absolute checkout the isolated tree is cut from, when the host knows one.
   */
  acceptIssue(entry: Entry, source?: string): void
  /** A `review` entry: add the note to the job that holds the thread. */
  acceptReview(entry: Entry): void
  /** A `close` entry: reclaim the worker it names and answer `closed`. */
  acceptClose(entry: Entry): void
  /** Answer an unsupported delivery kind with what this runner accepts. */
  refuseKind(entry: Entry): void
  /**
   * Read one worker's session feed.
   * @param worker - the worker address, or the bare id its address carries.
   * @returns the feed, or why the worker or its log could not be read.
   */
  readEvents(worker: string): Promise<WorkerEventsResult>
  /** Abort every job, release every checkout it still holds, and refuse new work. */
  shutdown(): Promise<void>
}

/**
 * Build the coordinator.
 * @param settings - concurrency, branch naming, the patch-inline ceiling and the
 *   judgement floor.
 * @param ports - the backend, the reply channel, the log sink and the judge.
 * @returns the service the plugin publishes and the node's runtime drives.
 */
/** The stable, semantic address of one worker; a review can name it directly. */
function workerOf(job: Job): string {
  return `onlyne://runner/issue/${job.workerId}`
}

/** Move a job to a new state, and stamp the catalog's `updatedAt`. */
function mark(job: Job, state: IssueJobState): void {
  job.state = state
  job.updatedAt = Date.now()
}

/** The message's meta, read as a record: `work` is a first-class field there. */
function metaOf(entry: Entry): Record<string, unknown> {
  return (entry.message.meta ?? {}) as unknown as Record<string, unknown>
}

/** The message's `meta.data`, which is where an in-process send puts its keys. */
function dataOf(entry: Entry): Record<string, Json> {
  return entry.message.meta?.data ?? {}
}

/** One non-empty string from a loosely typed record. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * An untrusted `meta.work` value, read as the fields the protocol defines.
 * A message's meta is a JSON boundary: the shape is checked here, once.
 */
function declaredWork(value: unknown): { unit?: unknown; parent?: unknown; attempt?: unknown } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as { unit?: unknown; parent?: unknown; attempt?: unknown }
    : undefined
}

/** An untrusted `in_reply_to` value, read as the two fields a message reference has. */
function declaredRef(value: unknown): { sender?: unknown; id?: unknown } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as { sender?: unknown; id?: unknown }
    : undefined
}

/** The id inside a worker address, or a bare id a caller sent as one. */
function workerIdOf(value: unknown): string | undefined {
  const raw = stringOf(value)
  if (raw === undefined) return undefined
  const match = /^(?:onlyne|runner):\/\/runner\/issue\/([A-Za-z0-9][A-Za-z0-9._~-]*)$/u.exec(raw)
  if (match?.[1] !== undefined) return match[1]
  return raw.includes('://') ? undefined : raw
}

/**
 * The work unit one entry carries.
 *
 * `meta.work` is the field the protocol defines; `meta.data.work` is the same
 * value after an in-process send, which stores the whole input meta as
 * `meta.data`. A caller that predates the field names its unit in
 * `meta.data.workUnit` or `meta.data.issueId`, and that is read as the unit so
 * an old Bot still joins the job it means.
 */
function workOf(entry: Entry): WorkRef | undefined {
  const meta = metaOf(entry)
  const data = dataOf(entry) as Record<string, unknown>
  const declared = declaredWork(meta.work) ?? declaredWork(data.work)
  const unit = stringOf(declared?.unit) ?? stringOf(data.workUnit) ?? stringOf(data.issueId)
  if (unit === undefined) return undefined
  const rawParent = declared?.parent
  const parent = rawParent === null || typeof rawParent === 'string' ? rawParent : undefined
  const attempt = typeof declared?.attempt === 'number' && Number.isInteger(declared.attempt) && declared.attempt > 0
    ? declared.attempt
    : undefined
  return { unit, ...parent === undefined ? {} : { parent }, ...attempt === undefined ? {} : { attempt } }
}

/** The reviewing decision one entry carries, if it carries one. */
function verdictOf(entry: Entry): 'approve' | 'reject' | undefined {
  const meta = metaOf(entry)
  const data = dataOf(entry) as Record<string, unknown>
  const raw = stringOf(data.verdict) ?? stringOf(meta.verdict)
  return raw === 'approve' || raw === 'reject' ? raw : undefined
}

/** The note one review adds to the next run's prompt. */
function noteOf(entry: Entry, verdict: 'approve' | 'reject' | undefined): string {
  const body = entry.message.msg.trim()
  if (verdict === 'reject' && body === '') return 'The reviewer rejected this change set; rework it.'
  return entry.message.msg
}

/** The `note` answer to a second filing of work a live worker already holds. */
function adoptedBody(job: Job): string {
  const machine = job.provisioned?.machine
  return [
    `Work unit ${job.workUnit ?? '(unnamed)'} is already held by ${workerOf(job)} (job ${job.id}, state ${job.state}).`,
    ...machine === undefined ? [] : [`machine: ${machine}`],
    '',
    'This message is attached to that worker: its pr, failed and closed answers arrive here too.',
    'Continue it with delivery_kind "review" in this thread, or name the worker in meta.worker. '
    + 'Do not file a second issue for the same unit — a new attempt is the only thing that starts a new job.',
  ].join('\n')
}

/** The card data the deduplicating `note` answer carries. */
function adoptedData(job: Job): Record<string, Json> {
  return {
    job: job.id,
    jobId: job.id,
    worker: workerOf(job),
    workerId: job.workerId,
    machine: job.provisioned?.machine ?? null,
    state: job.state,
    work: workJson(job.work),
    workUnit: job.workUnit ?? null,
    adopted: true,
  }
}

/** The `closed` answer to an approving review. */
function approveBody(job: Job): string {
  const machine = job.provisioned?.machine
  return machine === undefined
    ? `Worker ${workerOf(job)} is approved; its checkout is released.`
    : `Worker ${workerOf(job)} is approved; its checkout is released and machine ${machine} is gone.`
}

/** The card data an approving review's answer carries. */
function approveData(job: Job): Record<string, Json> {
  return {
    job: job.id,
    jobId: job.id,
    worker: workerOf(job),
    workerId: job.workerId,
    machine: job.provisioned?.machine ?? null,
    state: 'approved',
    verdict: 'approve',
    work: workJson(job.work),
    workUnit: job.workUnit ?? null,
    reclaimed: true,
  }
}

export function createJobs(settings: JobSettings, ports: JobPorts): JobService {
  const jobs = new Map<string, Job>()
  /** Internal-path address → job identity. The path is what a caller sees; the id is what this service holds. */
  const workers = new Map<string, string>()
  const queue: Job[] = []
  const inflight = new Set<Promise<void>>()
  let running = 0
  let closed = false

  /** Put a job back in line; a queued job never starts while the runner is closed. */
  function enqueue(job: Job): void {
    if (closed || interrupted(job)) return
    mark(job, 'queued')
    queue.push(job)
    pump()
  }

  /**
   * Start as many queued jobs as the ceiling allows.
   *
   * A cancelled job is skipped rather than run: `cancel` cannot remove it from
   * the middle of the queue, so the pump filters instead.
   */
  function pump(): void {
    if (closed) return
    while (running < settings.maxConcurrent) {
      const next = queue.shift()
      if (next === undefined) return
      if (next.state !== 'queued') continue
      running++
      const run = runJob(next).finally(() => {
        running--
        inflight.delete(run)
        if (next.running === run) next.running = undefined
        pump()
      })
      next.running = run
      inflight.add(run)
    }
  }

  /**
   * Run one job until it has nothing left to do.
   *
   * The loop is what makes a review note a follow-up instead of a new job: a
   * note that arrived while the agent was running is picked up here, in the
   * same checkout, without waiting for a second queue turn.
   * @param job - the job to run.
   */
  async function runJob(job: Job): Promise<void> {
    mark(job, 'running')
    try {
      if (job.provisioned === undefined) {
        job.provisioned = await ports.backend.provision(snapshotOf(job))
        job.branch = job.provisioned.branch
        job.leaseId = job.provisioned.leaseId
        job.desktopUrl = job.provisioned.desktopUrl
        // A cancel or close that landed while the checkout was being created
        // never reached the backend's activation, so the tree is released here.
        if (interrupted(job)) {
          await reclaim(job)
          return
        }
      }
      for (;;) {
        job.delivered.push(...job.notes.splice(0, job.notes.length))
        job.failure = undefined
        const result = await ports.backend.launch(snapshotOf(job), job.provisioned)
        job.last = result
        // A review run starts a fresh agent, so this is the latest session,
        // not necessarily the first one; the feed follows the latest.
        job.session = result.childId ?? job.session
        // The run was stopped while it was going: the answer would describe
        // work nobody is waiting for, so the checkout goes back instead.
        if (interrupted(job)) {
          await reclaim(job)
          return
        }
        const collection = await ports.backend.collect(snapshotOf(job))
        job.collection = collection
        if (result.stopReason === 'error') {
          // A provider or transport failure is a failed run by construction:
          // no agent report exists, so there is nothing for the judge to read,
          // and calling it `refused` or a change set ready for review would
          // dress an execution error up as the agent's decision.
          job.failure = result.diagnostic ?? 'the coding agent stopped on a provider error'
          await deliver(job, 'failed', stopFailureBody(job, result), stopFailureData(job, result))
        } else {
          // A settled turn is not the same as finished work: an agent whose
          // sandbox denied every write also stops `completed`, and the answer it
          // leaves behind says so in prose. The judge is what reads that prose.
          const verdict = await judgeOutcome(job, result, settings, ports)
          if (verdict.judged && verdict.label === 'refused') {
            await deliver(job, 'failed', refusalBody(job, result, verdict), refusalData(job, result, verdict))
          } else {
            await deliver(
              job,
              'pr',
              prBody(job, result, collection, settings, verdict),
              prData(job, result, collection),
            )
          }
        }
        if (interrupted(job)) {
          await reclaim(job)
          return
        }
        // Checked after the last await: a note that landed during the answer is
        // this loop's business, not the queue's.
        if (job.notes.length === 0) break
      }
      mark(job, 'idle')
      settle(job)
    } catch (error) {
      if (interrupted(job)) {
        await reclaim(job)
        return
      }
      job.failure = reasonOf(error)
      mark(job, 'failed')
      await deliver(job, 'failed', failureBody(job), { job: job.id, reason: job.failure })
      settle(job)
    }
  }

  /**
   * Give one job's checkout and machine back, once.
   *
   * A running job reclaims as it unwinds, and the `close` that stopped it
   * reclaims too; both await the same promise, so the backend disposes exactly
   * once and the failure is reported rather than hidden.
   */
  async function reclaim(job: Job): Promise<void> {
    job.disposal ??= (async () => {
      try {
        await ports.backend.dispose(snapshotOf(job))
      } catch (error) {
        ports.log(`omd-issue-runner: job "${job.id}" was not released: ${reasonOf(error)}`)
      }
    })()
    await job.disposal
  }

  /**
   * Start the retain window of a job that has nothing left to do.
   *
   * A settled worker is kept long enough for a human to read the change set
   * and the run, then reclaims itself through the same path a `close` takes.
   * `settleReclaimMs: 0` turns that off and leaves the worker to its caller.
   *
   * One worker is never put on the clock: one whose last change set was larger
   * than `maxPatchBytes`, because that patch was never inlined in any answer
   * and the checkout is its only copy — reclaiming it would destroy the work
   * the review is about to ask for. An explicit `close` or `approve` still
   * reclaims it.
   * @param job - the job that just settled.
   */
  function settle(job: Job): void {
    cancelReclaim(job)
    if (settings.settleReclaimMs <= 0 || interrupted(job)) return
    if (job.collection !== undefined && job.collection.patchBytes > settings.maxPatchBytes) return
    const timer = setTimeout(() => {
      job.reclaimTimer = undefined
      void reclaimSettled(job)
    }, settings.settleReclaimMs)
    // A pending reclaim is not a reason for the process to stay alive.
    timer.unref()
    job.reclaimTimer = timer
    job.reclaimAt = Date.now() + settings.settleReclaimMs
  }

  /**
   * Drop a scheduled reclaim: the worker has a caller again, or is going away
   * through a path that reclaims it itself.
   * @param job - the job whose window is being dropped.
   */
  function cancelReclaim(job: Job): void {
    if (job.reclaimTimer !== undefined) {
      clearTimeout(job.reclaimTimer)
      job.reclaimTimer = undefined
    }
    job.reclaimAt = undefined
  }

  /**
   * Close one worker whose retain window ran out.
   *
   * The state is re-read rather than trusted: a review or a close that landed
   * between the timer and this call has already done the work, and a job that
   * started running again must not be destroyed under its run.
   * @param job - the job the timer fired for.
   */
  async function reclaimSettled(job: Job): Promise<void> {
    job.reclaimAt = undefined
    if (interrupted(job) || (job.state !== 'idle' && job.state !== 'failed')) return
    await closeJob(job)
  }

  /**
   * Send a job's answer into its thread.
   *
   * A delivery failure does not change the job: the work is done either way,
   * and the reason it could not be announced belongs in the log, not in a
   * second failed job.
   */
  async function deliver(job: Job, kind: RunnerReply['kind'], body: string, data: Record<string, Json>): Promise<void> {
    for (const reader of job.readers) {
      try {
        await ports.send({
          kind,
          body,
          to: reader.requester,
          thread: { owner: reader.thread.owner, id: reader.thread.id },
          ...reader.inReplyTo === undefined
            ? {}
            : { inReplyTo: { sender: reader.inReplyTo.sender, id: reader.inReplyTo.id } },
          data,
        })
      } catch (error) {
        ports.log(`omd-issue-runner: the ${kind} answer for job "${job.id}" was not delivered: ${reasonOf(error)}`)
      }
    }
  }

  /** Answer one entry in its own thread, for the requests that never become a job. */
  async function answer(
    entry: Entry,
    kind: RunnerReply['kind'],
    body: string,
    data: Record<string, Json> = {},
  ): Promise<void> {
    try {
      await ports.send({
        kind,
        body,
        to: entry.authenticated_author,
        thread: { owner: entry.thread_ref.owner, id: entry.thread_ref.id },
        inReplyTo: { sender: entry.message.sender, id: entry.message.id },
        data,
      })
    } catch (error) {
      ports.log(`omd-issue-runner: a ${kind} answer was not delivered: ${reasonOf(error)}`)
    }
  }

  /** Build one job from a submission; the caller stores and enqueues it. */
  function createJob(input: IssueSubmitInput): Job {
    const id = randomUUID().slice(0, 8)
    const workerId = randomUUID().slice(0, 8)
    const given = input.title?.trim() ?? ''
    const title = given === '' ? firstLine(input.text) || `issue ${id}` : given
    const at = Date.now()
    const thread = input.thread
    const requester = input.requester
    return {
      id,
      workerId,
      title,
      issue: input.text.trim(),
      source: input.source ?? process.cwd(),
      branch: `${settings.branchPrefix}${id}`,
      ...input.work === undefined ? {} : { workUnit: input.work.unit, work: input.work },
      controller: new AbortController(),
      notes: [],
      delivered: [],
      state: 'queued',
      thread,
      requester,
      inReplyTo: input.inReplyTo,
      readers: thread === undefined || requester === undefined
        ? []
        : [{
            thread: { owner: thread.owner, id: thread.id },
            requester,
            ...input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo },
          }],
      startedAt: at,
      updatedAt: at,
    }
  }

  /** The job that holds one thread, or undefined when this runner never took it. */
  function byThread(thread: ThreadRef): Job | undefined {
    for (const job of jobs.values()) {
      if (job.thread?.owner === thread.owner && job.thread.id === thread.id) return job
      if (job.readers.some(reader => reader.thread.owner === thread.owner && reader.thread.id === thread.id)) {
        return job
      }
    }
    return undefined
  }

  /**
   * Find the worker a message names by id. The thread a Bot replies in is not
   * always the thread the runner answered in, so the worker address is the
   * reliable identity: it names the checkout that must continue, not a
   * conversation the caller happened to be in.
   */
  function byWorkerId(workerId: string): Job | undefined {
    const id = workers.get(`onlyne://runner/issue/${workerId}`)
    if (id !== undefined) return jobs.get(id)
    for (const job of jobs.values()) if (job.workerId === workerId) return job
    return undefined
  }

  /** The live job filed under one work unit, if any. */
  function byWork(work: WorkRef | undefined): Job | undefined {
    if (work === undefined) return undefined
    for (const job of jobs.values()) {
      if (interrupted(job)) continue
      if (job.workUnit !== work.unit) continue
      if ((job.work?.attempt ?? 1) !== (work.attempt ?? 1)) continue
      return job
    }
    return undefined
  }

  /**
   * The job one entry is about, from the strongest identity it carries: a
   * worker id, then a job id, then the work unit, then the thread, then the
   * message it answers. A review sent from a new thread names its work unit and
   * lands here instead of opening a second machine.
   */
  function resolveTarget(entry: Entry): Job | undefined {
    const data = dataOf(entry) as Record<string, unknown>
    const workerId = workerIdOf(data.worker) ?? workerIdOf(data.workerId)
    if (workerId !== undefined) {
      const job = byWorkerId(workerId)
      if (job !== undefined) return job
    }
    const jobId = stringOf(data.jobId)
    if (jobId !== undefined) {
      const job = jobs.get(jobId)
      if (job !== undefined) return job
    }
    return byWork(workOf(entry)) ?? byThread(entry.thread_ref) ?? byReference(entry)
  }

  /** The job whose answer one entry replies to, when it names an answer of ours. */
  function byReference(entry: Entry): Job | undefined {
    const meta = metaOf(entry)
    const data = dataOf(entry) as Record<string, unknown>
    const ref = declaredRef(meta.in_reply_to) ?? declaredRef(data.in_reply_to)
    const id = stringOf(ref?.id)
    const sender = stringOf(ref?.sender)
    if (id === undefined) return undefined
    for (const job of jobs.values()) {
      if (job.inReplyTo?.id === id) return job
      if (job.readers.some(reader => reader.inReplyTo?.id === id
        && (sender === undefined || reader.inReplyTo.sender === sender))) {
        return job
      }
    }
    return undefined
  }

  /**
   * Record that one entry's thread reads this job. A review from another
   * thread, or a second filing of the same unit, joins the delivery list
   * instead of opening a second job.
   */
  function remember(job: Job, entry: Entry): void {
    const thread = { owner: entry.thread_ref.owner, id: entry.thread_ref.id }
    const inReplyTo = { sender: entry.message.sender, id: entry.message.id }
    const found = job.readers.find(reader => reader.thread.owner === thread.owner && reader.thread.id === thread.id)
    if (found === undefined) {
      job.readers.push({ thread, requester: entry.authenticated_author, inReplyTo })
    } else {
      found.requester = entry.authenticated_author
      found.inReplyTo = inReplyTo
    }
    job.requester = entry.authenticated_author
    job.inReplyTo = inReplyTo
  }

  /** The workers a caller could still hand work to, as the addresses a `close` or `review` names. */
  function liveWorkers(): string[] {
    return [...jobs.values()]
      .filter(job => job.provisioned !== undefined && !interrupted(job))
      .map(workerOf)
  }

  /**
   * Reclaim one worker: stop what is running, destroy its checkout and machine,
   * and stop answering reviews for it.
   *
   * A running job is aborted and its turn awaited before the release, because
   * the backend's `dispose` deletes the machine the agent is still executing
   * in. The unwinding run reclaims on its own, so the release happens once
   * however many callers ask for it.
   * @param job - the job to reclaim.
   * @param state - `closed` for a close, `approved` for an approving review.
   */
  async function reclaimWorker(job: Job, state: 'closed' | 'approved' = 'closed'): Promise<void> {
    cancelReclaim(job)
    workers.delete(workerOf(job))
    if (job.state === 'closed' || job.state === 'approved') return
    const run = job.running
    mark(job, state)
    job.controller.abort(new Error(state === 'approved' ? 'the worker was approved' : 'the worker was closed'))
    if (run !== undefined) await Promise.allSettled([run])
    await reclaim(job)
  }

  /** Reclaim one worker and answer `closed` under it, in its thread. */
  async function closeJob(job: Job): Promise<void> {
    await reclaimWorker(job)
    await deliver(job, 'closed', closeBody(job), closeData(job))
  }

  /** Reclaim one approved worker and answer under it, in every thread that asked. */
  async function approveJob(job: Job): Promise<void> {
    await reclaimWorker(job, 'approved')
    await deliver(job, 'closed', approveBody(job), approveData(job))
  }

  /** A `close` entry: reclaim the worker it names, or say which workers are live. */
  async function closeFrom(entry: Entry): Promise<void> {
    const job = resolveTarget(entry)
    if (job === undefined) {
      const data = dataOf(entry) as Record<string, unknown>
      const named = workerIdOf(data.worker) ?? workerIdOf(data.workerId)
      const worker = named === undefined ? '' : `onlyne://runner/issue/${named}`
      const orphan = worker === '' || ports.reclaimOrphan === undefined
        ? undefined
        : await ports.reclaimOrphan(worker)
      if (orphan !== undefined) {
        await answer(entry, 'closed', [
          `Worker ${worker} is closed; its machine ${orphan.machine} was destroyed.`,
          'No job state remained in this process, so the host checkout is left to the allocator sweep.',
        ].join('\n'), { worker, machine: orphan.machine, reclaimed: true })
        return
      }
      const known = liveWorkers()
      await answer(entry, 'failed', [
        'close: no worker holds this thread, and no live worker id was given.',
        'Name the worker in meta.worker, or close from the thread the job answered in.',
        ...known.length === 0 ? [] : ['', `Live workers: ${known.join(', ')}.`],
      ].join('\n'))
      return
    }
    await closeJob(job)
  }

  return {
    submit(input: IssueSubmitInput): IssueJobView {
      if (closed) throw new Error('omd-issue-runner: the runner is unloading; no job was queued')
      if (input.text.trim() === '') throw new Error('omd-issue-runner: an issue needs a non-empty body')
      // One unit of work is one job and one machine: a second submit joins the
      // first instead of queuing a twin.
      const existing = byWork(input.work)
      if (existing !== undefined) return viewOf(existing)
      const job = createJob(input)
      jobs.set(job.id, job)
      workers.set(workerOf(job), job.id)
      enqueue(job)
      return viewOf(job)
    },

    list(): IssueJobView[] {
      return [...jobs.values()].map(viewOf)
    },

    workers(): WorkerRecord[] {
      return [...jobs.values()].filter(job => !interrupted(job)).map(workerRecordOf)
    },

    async readEvents(worker: string): Promise<WorkerEventsResult> {
      const workerId = workerIdOf(worker)
      if (workerId === undefined) {
        return { kind: 'missing', reason: `${JSON.stringify(worker)} is not a worker address` }
      }
      const job = byWorkerId(workerId)
      if (job === undefined) {
        return {
          kind: 'missing',
          reason: `onlyne://runner/issue/${workerId} names no worker this process created; `
            + 'read onlyne://runner/workers for the list.',
        }
      }
      const session = sessionOf(job)
      if (session === undefined) {
        // An accepted worker spends its first seconds provisioning, and a
        // watcher opens the feed exactly then. An empty feed with a status
        // line is the honest answer: nothing is wrong, nothing has run yet.
        return {
          kind: 'feed',
          value: {
            worker: workerOf(job),
            state: job.state,
            events: [],
            truncated: false,
            note: 'the coding-agent session has not started yet',
          },
        }
      }
      if (ports.readSession === undefined) {
        return {
          kind: 'missing',
          reason: `the coding-agent session ${session} cannot be read: this host keeps no session log`,
        }
      }
      const records = await ports.readSession(session)
      if (records === undefined) {
        return {
          kind: 'missing',
          reason: `the coding-agent session ${session} of worker ${workerOf(job)} has no log on this host`,
        }
      }
      const { events, truncated } = summarizeSession(records)
      return { kind: 'feed', value: { worker: workerOf(job), state: job.state, events, truncated } }
    },

    cancel(jobId: string): boolean {
      const job = jobs.get(jobId)
      if (job === undefined) return false
      if (interrupted(job)) return true
      const wasRunning = job.state === 'running'
      cancelReclaim(job)
      mark(job, 'cancelled')
      job.controller.abort(new Error('the job was cancelled'))
      // A running job releases its own checkout when the run unwinds; anything
      // else holds nothing the abort could reach.
      if (!wasRunning) void reclaim(job)
      return true
    },

    async close(jobId: string): Promise<boolean> {
      const job = jobs.get(jobId)
      if (job === undefined) return false
      await closeJob(job)
      return true
    },

    acceptIssue(entry: Entry, source?: string): void {
      const body = entry.message.msg
      if (body.trim() === '') {
        void answer(entry, 'failed', 'issue: the message body is empty, so no job was started.')
        return
      }
      if (closed) {
        void answer(entry, 'failed', 'the runner is unloading, so no job was started.')
        return
      }
      const work = workOf(entry)
      const existing = byWork(work)
      if (existing !== undefined) {
        // The veil of thread-only identity: this is the same work, filed
        // again from another thread. Answer with the worker that already
        // holds it and let that thread read its later answers too.
        remember(existing, entry)
        void answer(entry, 'note', adoptedBody(existing), adoptedData(existing))
        return
      }
      const job = createJob({
        text: body,
        ...source === undefined ? {} : { source },
        ...work === undefined ? {} : { work },
        thread: { owner: entry.thread_ref.owner, id: entry.thread_ref.id },
        requester: entry.authenticated_author,
        inReplyTo: { sender: entry.message.sender, id: entry.message.id },
      })
      jobs.set(job.id, job)
      workers.set(workerOf(job), job.id)
      enqueue(job)
    },

    acceptReview(entry: Entry): void {
      const job = resolveTarget(entry)
      if (job === undefined) {
        const known = liveWorkers()
        void answer(
          entry,
          'failed',
          [
            'review: no worker holds this thread, and no worker id or work unit was given.',
            'Send the review in the same Onlyne thread as the original issue, name the worker in meta.worker,',
            'or name the work unit in meta.work.unit.',
            ...known.length === 0 ? [] : ['', `Live workers: ${known.join(', ')}.`],
          ].join('\n'),
        )
        return
      }
      const verdict = verdictOf(entry)
      // The reviewer's decision belongs under the note that carried it, and
      // that thread now reads this job's answers too.
      remember(job, entry)
      if (verdict === 'approve') {
        void approveJob(job)
        return
      }
      if (job.provisioned === undefined || interrupted(job)) {
        void answer(
          entry,
          'failed',
          `review: job ${job.id} no longer holds a checkout, so this note was not applied. `
          + 'File the work again with delivery_kind "issue".',
        )
        return
      }
      job.notes.push(noteOf(entry, verdict))
      // A caller is waiting on this worker again: its retain window must not
      // close the checkout under the run this note is about to start.
      cancelReclaim(job)
      if (job.state === 'idle' || job.state === 'failed') enqueue(job)
    },

    acceptClose(entry: Entry): void {
      void closeFrom(entry)
    },

    refuseKind(entry: Entry): void {
      void answer(entry, 'note', [
        `omd-issue-runner does not handle delivery_kind "${entry.message.delivery_kind}".`,
        '',
        'It accepts three kinds:',
        '- "issue" — start a job in an isolated checkout; the answer comes back as "pr" or "failed".',
        '- "review" — add feedback to the job that holds this thread; the agent runs again in the same checkout.',
        '- "close" — reclaim the worker named in meta.worker: its checkout and its machine are destroyed, '
        + 'and the answer comes back as "closed".',
      ].join('\n'))
    },

    async shutdown(): Promise<void> {
      closed = true
      for (const job of jobs.values()) {
        cancelReclaim(job)
        if (interrupted(job)) continue
        mark(job, 'cancelled')
        job.controller.abort(new Error('the issue runner was unloaded'))
      }
      await Promise.allSettled([...inflight])
      await Promise.all([...jobs.values()].filter(job => job.provisioned !== undefined).map(reclaim))
    },
  }

  /** The immutable job description a backend receives. */
  function snapshotOf(job: Job): CodingAgentJob {
    return {
      id: job.id,
      workerId: job.workerId,
      title: job.title,
      issue: job.issue,
      notes: [...job.delivered],
      branch: job.branch,
      source: job.source,
      ...job.work === undefined ? {} : { work: job.work },
      ...job.thread === undefined ? {} : { thread: `${job.thread.owner}/${job.thread.id}` },
      ...job.requester === undefined ? {} : { requester: job.requester },
      signal: job.controller.signal,
    }
  }

  /**
   * The session a worker's feed belongs to.
   *
   * The backend answers first: it knows the session the moment the agent is
   * created, which is the only way a watcher sees a review run's session while
   * that run is going — `job.session` is written after `launch` resolves and
   * still names the previous run until then. The recorded id is the fallback
   * for what the backend cannot answer any more: a run that failed before it
   * returned a result, and a worker whose backend state was disposed.
   * @param job - the worker.
   * @returns the session id, or undefined when no run has started.
   */
  function sessionOf(job: Job): string | undefined {
    return ports.backend.sessionOf?.(snapshotOf(job)) ?? job.session
  }

  /** One worker as the catalog reports it. */
  function workerRecordOf(job: Job): WorkerRecord {
    const session = sessionOf(job)
    return {
      worker: workerOf(job),
      workerId: job.workerId,
      jobId: job.id,
      machine: job.provisioned?.machine ?? '',
      thread: job.thread === undefined ? '' : `${job.thread.owner}/${job.thread.id}`,
      state: job.state,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      ...job.workUnit === undefined ? {} : { workUnit: job.workUnit },
      ...job.work === undefined ? {} : { work: job.work },
      ...job.leaseId === undefined ? {} : { leaseId: job.leaseId },
      ...job.desktopUrl === undefined ? {} : { desktopUrl: job.desktopUrl },
      ...session === undefined ? {} : { session },
      ...job.reclaimAt === undefined ? {} : { reclaimAt: job.reclaimAt },
    }
  }

  /** The outward view of one job. */
  function viewOf(job: Job): IssueJobView {
    return {
      id: job.id,
      worker: workerOf(job),
      workerId: job.workerId,
      title: job.title,
      branch: job.branch,
      state: job.state,
      ...job.thread === undefined ? {} : { thread: `${job.thread.owner}/${job.thread.id}` },
      ...job.provisioned?.machine === undefined ? {} : { machine: job.provisioned.machine },
      ...job.workUnit === undefined ? {} : { workUnit: job.workUnit },
      ...job.work === undefined ? {} : { work: job.work },
      ...job.provisioned === undefined ? {} : { worktreePath: job.provisioned.worktreePath },
      ...job.collection === undefined
        ? {}
        : { files: job.collection.changedFiles.length, patchBytes: job.collection.patchBytes },
      ...job.last === undefined || job.last.summary === '' ? {} : { summary: job.last.summary },
      ...job.failure === undefined ? {} : { failure: job.failure },
    }
  }
}

/** What the judgement step decided about one finished run. */
type Verdict =
  | {
    /** The judge was not asked, or its answer was too uncertain to act on. */
    readonly judged: false
    /** Why the run carries no judgement, in words the thread can read. */
    readonly why: string
  }
  | {
    readonly judged: true
    readonly label: 'accomplished' | 'refused' | 'partial'
    /** Probability the judge attached to that label, at or above the floor. */
    readonly confidence: number
  }

/** Report characters shown to the judge; a runaway transcript is not a bigger question. */
const JUDGE_REPORT_MAX_CHARS = 16_000

/**
 * The one question the runner asks.
 *
 * The stop reason cannot answer it: an agent that refused its task, or found
 * its sandbox closing the checkout, still ends its turn cleanly. So the labels
 * carry the reading, and the instructions say what the prose looks like —
 * a report of inability is a refusal however politely it is written.
 */
const OUTCOME_QUESTION = {
  type: 'choice' as const,
  instructions: [
    'Decide what the coding agent actually did with the issue it was given.',
    'It ran in an isolated checkout and its report is what you have: it may have been stopped by a sandbox,',
    'by the wrong directory, by a missing tool, or by its own judgement.',
    'A report that says it could not do the work, had no access, made no change, or hands the work back',
    'to someone else is a refusal, however politely it is worded; the stop reason alone does not decide.',
    'Real edits that leave part of the issue undone are partial.',
  ].join(' '),
  criteria: {
    accomplished: 'The agent reports the requested change as made, and nothing in the report says otherwise.',
    refused: 'The agent reports it did not or could not do the work; no change was made.',
    partial: 'The agent made part of the change and says what is left undone.',
  },
}

/**
 * Ask the judge what one run actually did.
 *
 * Every way of not getting an answer — judging switched off, no judge mounted,
 * no usable candidate, an untenable confidence, a failed call — keeps the
 * runner's previous behaviour and says so in the answer text, because a run
 * reported as finished without being checked must not look checked.
 * @param job - the job that just ran.
 * @param result - what the run reported.
 * @param settings - confidence floor and whether judging is on.
 * @param ports - where the judge is read from.
 * @returns the verdict, or the reason there is none.
 */
async function judgeOutcome(
  job: Job,
  result: RunResult,
  settings: JobSettings,
  ports: JobPorts,
): Promise<Verdict> {
  if (!settings.judgeResults) return { judged: false, why: 'judging is off (judgeResults: false)' }
  const judgment = ports.judgment?.()
  if (judgment === undefined) return { judged: false, why: 'no judge is mounted' }
  if (!judgment.available()) return { judged: false, why: 'the mounted judge has no usable route' }
  let answer: ChoiceVerdict | undefined
  try {
    const settled = await judgment.judge(
      {
        state: {
          issue: taskOf(job),
          stop: result.stopReason,
          report: clip(result.summary),
        },
        questions: { outcome: OUTCOME_QUESTION },
      },
      { signal: job.controller.signal },
    )
    answer = settled.answers.outcome
  } catch (error) {
    return { judged: false, why: `the judge failed: ${reasonOf(error)}` }
  }
  if (answer === undefined) return { judged: false, why: 'the judge answered nothing' }
  if (answer.confidence < settings.confidenceFloor) {
    return {
      judged: false,
      why: `the judge was unsure (${answer.choice} at confidence ${answer.confidence.toFixed(2)} `
        + `< floor ${settings.confidenceFloor.toFixed(2)})`,
    }
  }
  if (answer.choice === 'accomplished' || answer.choice === 'refused' || answer.choice === 'partial') {
    return { judged: true, label: answer.choice, confidence: answer.confidence }
  }
  return { judged: false, why: `the judge answered an unknown label "${answer.choice}"` }
}

/** The issue plus every note handed to the run, for the judge and the prompt. */
function taskOf(job: Job): string {
  return [job.issue, ...job.delivered.map(note => `Review note:\n${note}`)].join('\n\n')
}

/** Keep one judge input bounded; the tail of a long report rarely changes the answer. */
function clip(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= JUDGE_REPORT_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, JUDGE_REPORT_MAX_CHARS)}\n[report truncated]`
}

/** The `pr` answer: what changed, where it is, and the patch when it fits. */
function prBody(
  job: Job,
  result: RunResult,
  collection: RunCollection,
  settings: JobSettings,
  verdict: Verdict,
): string {
  const lines = [
    `Issue ${job.id} is ready for review.`,
    '',
    `branch: ${job.branch}`,
    `worktree: ${job.provisioned?.worktreePath ?? '(none)'}`,
    `changes: ${collection.changedFiles.length} file(s), ${collection.patchBytes} bytes`,
    `stop: ${result.stopReason}`,
    // A run can stop `error` with an empty report — a missing credential, a
    // dead provider — and the provider's own words are the only account of it.
    ...result.diagnostic === undefined ? [] : [`diagnostic: ${result.diagnostic}`],
    verdictLine(verdict),
    '',
    result.summary.trim() === '' ? '(the agent returned no summary)' : result.summary.trim(),
  ]
  if (collection.patch.trim() === '') {
    lines.push('', 'The run left no change in the checkout.')
  } else if (collection.patchBytes <= settings.maxPatchBytes) {
    lines.push('', '```diff', collection.patch.trimEnd(), '```')
  } else {
    lines.push(
      '',
      `The patch is omitted because the change set is larger than maxPatchBytes `
      + `(${settings.maxPatchBytes} bytes); the change set is not empty. Read it in the worktree above, `
      + `or from branch "${job.branch}".`,
    )
  }
  return lines.join('\n')
}

/** The `failed` answer for a run the provider stopped: a failure, not a judgement. */
function stopFailureBody(job: Job, result: RunResult): string {
  const lines = [
    `Issue ${job.id} failed.`,
    '',
    'reason: the coding agent stopped on a provider error, so no work was done',
    `branch: ${job.branch}`,
    ...job.provisioned === undefined ? [] : [`worktree: ${job.provisioned.worktreePath}`],
    `stop: ${result.stopReason}`,
    ...result.diagnostic === undefined ? [] : [`diagnostic: ${result.diagnostic}`],
  ]
  if (result.summary.trim() !== '') lines.push('', 'The agent said:', '', result.summary.trim())
  return lines.join('\n')
}

/** The card data a provider-failure answer carries beside its text. */
function stopFailureData(job: Job, result: RunResult): Record<string, Json> {
  return {
    job: job.id,
    worker: workerOf(job),
    branch: job.branch,
    worktree: job.provisioned?.worktreePath ?? null,
    stop: result.stopReason,
    ...result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic },
  }
}

/** The `failed` answer for a run the judge heard as a refusal. */
function refusalBody(
  job: Job,
  result: RunResult,
  verdict: Extract<Verdict, { judged: true }>,
): string {
  const lines = [
    `Issue ${job.id} failed.`,
    '',
    `reason: the coding agent reported it did not do the work `
    + `(judged ${verdict.label}, confidence ${verdict.confidence.toFixed(2)})`,
    `branch: ${job.branch}`,
    ...job.provisioned === undefined ? [] : [`worktree: ${job.provisioned.worktreePath}`],
    `stop: ${result.stopReason}`,
    ...result.diagnostic === undefined ? [] : [`diagnostic: ${result.diagnostic}`],
  ]
  if (result.summary.trim() !== '') lines.push('', 'The agent said:', '', result.summary.trim())
  return lines.join('\n')
}

/** The card data a refusal carries beside its text. */
function refusalData(
  job: Job,
  result: RunResult,
  verdict: Extract<Verdict, { judged: true }>,
): Record<string, Json> {
  return {
    job: job.id,
    worker: workerOf(job),
    branch: job.branch,
    worktree: job.provisioned?.worktreePath ?? null,
    stop: result.stopReason,
    ...result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic },
    verdict: verdict.label,
    confidence: verdict.confidence,
  }
}

/** One line saying whether the run was judged and how confident the judge was. */
function verdictLine(verdict: Verdict): string {
  return verdict.judged
    ? `verdict: judged ${verdict.label} (confidence ${verdict.confidence.toFixed(2)})`
    : `verdict: not judged — ${verdict.why}`
}

/** The card data a `pr` answer carries beside its text. */
function prData(job: Job, result: RunResult, collection: RunCollection): Record<string, Json> {
  return {
    job: job.id,
    worker: workerOf(job),
    branch: job.branch,
    worktree: job.provisioned?.worktreePath ?? null,
    ...job.provisioned?.machine === undefined ? {} : { machine: job.provisioned.machine },
    files: collection.changedFiles.length,
    patchBytes: collection.patchBytes,
    stop: result.stopReason,
    ...result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic },
    ...result.childId === undefined ? {} : { child: result.childId },
  }
}

/** The `failed` answer: the job's identity and why it broke. */
function failureBody(job: Job): string {
  const lines = [`Issue ${job.id} failed.`, '', `reason: ${job.failure ?? 'unknown'}`]
  lines.push(`branch: ${job.branch}`)
  if (job.provisioned !== undefined) {
    lines.push(`worktree: ${job.provisioned.worktreePath}`)
    if (job.provisioned.machine !== undefined) lines.push(`machine: ${job.provisioned.machine}`)
  }
  if (job.last !== undefined && job.last.summary.trim() !== '') {
    lines.push('', 'The agent said:', '', job.last.summary.trim())
  }
  return lines.join('\n')
}

/** The `closed` answer: one line, because the card carries the addresses. */
function closeBody(job: Job): string {
  const machine = job.provisioned?.machine
  return machine === undefined
    ? `Worker ${workerOf(job)} is closed; its checkout is released.`
    : `Worker ${workerOf(job)} is closed; its checkout is released and machine ${machine} is gone.`
}

/** The card data a `closed` answer carries: what the reader can no longer reach. */
function closeData(job: Job): Record<string, Json> {
  return {
    job: job.id,
    worker: workerOf(job),
    machine: job.provisioned?.machine ?? null,
    worktree: job.provisioned?.worktreePath ?? null,
    reclaimed: true,
  }
}

/** The first non-empty line, trimmed, for a job's label. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.slice(0, 72)
  }
  return ''
}

/** One line of an arbitrary thrown value. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message
  return String(error)
}

/**
 * Whether a close or a cancel stopped this job while an `await` was in flight.
 *
 * The check is a function, not an inline comparison, because TypeScript would
 * otherwise keep the state narrowed across the await: the field is written by
 * `cancel` and `close` from outside the running task.
 * @param job - the job to check.
 */
function interrupted(job: Job): boolean {
  return job.state === 'cancelled' || job.state === 'closed' || job.state === 'approved'
}
