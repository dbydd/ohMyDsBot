import { describe, expect, test } from 'bun:test'
import type { Entry } from '@onlyne/lib'
import type { CodingAgentBackend, CodingAgentJob } from './backend.ts'
import { summarizeSession } from './events.ts'
import { createJobs, type JobService } from './jobs.ts'
import type { IssueJobView, IssueJudge, RunnerReply } from './types.ts'

/** What one fake backend did, so a test can count jobs and runs. */
interface FakeBackend {
  readonly backend: CodingAgentBackend
  readonly disposed: string[]
  /** Worker ids a checkout and machine were provisioned for. */
  readonly provisioned: string[]
  /** Runs started; a review adds one, a duplicate filing adds none. */
  readonly launches: string[]
}

/** A backend that records releases instead of moving files or machines. */
function fakeBackend(): FakeBackend {
  const disposed: string[] = []
  const provisioned: string[] = []
  const launches: string[] = []
  const backend: CodingAgentBackend = {
    name: 'fake',
    provision: async (job: CodingAgentJob) => {
      provisioned.push(job.workerId)
      return {
        worktreePath: `/tmp/omd-close-test/${job.id}`,
        branch: job.branch,
        machine: `omd-sandbox-scratch-${job.workerId}`,
      }
    },
    launch: async (job: CodingAgentJob) => {
      launches.push(job.id)
      return { summary: 'the change is in the checkout', stopReason: 'completed' }
    },
    collect: async () => ({ patch: '', patchBytes: 0, changedFiles: [] }),
    dispose: async (job: CodingAgentJob) => {
      disposed.push(job.id)
    },
  }
  return { backend, disposed, provisioned, launches }
}

interface Harness {
  readonly jobs: JobService
  readonly replies: RunnerReply[]
  readonly disposed: string[]
  /** One reply of a kind, once the coordinator has sent that many of it. */
  next(kind: RunnerReply['kind'], count?: number): Promise<RunnerReply>
}

/** What one test changes about the coordinator's settings and readers. */
interface HarnessOptions {
  settleReclaimMs?: number
  readSession?: (sessionId: string) => Promise<readonly unknown[] | undefined>
  /** Mount a judge, so a test can prove it was or was not consulted. */
  judge?: IssueJudge
  judgeResults?: boolean
}

function harness(
  ready: { backend: CodingAgentBackend; disposed: string[] } = fakeBackend(),
  reclaimOrphan?: (worker: string) => Promise<{ machine: string } | undefined>,
  options: HarnessOptions = {},
): Harness {
  const { backend, disposed } = ready
  const replies: RunnerReply[] = []
  const wakeups: (() => void)[] = []
  const jobs = createJobs(
    {
      maxConcurrent: 2,
      branchPrefix: 'issue/',
      maxPatchBytes: 1024,
      confidenceFloor: 0.5,
      judgeResults: options.judgeResults ?? false,
      // The reclaim window is its own fact below; a timer running under every
      // other test would dispose backends those tests still inspect.
      settleReclaimMs: options.settleReclaimMs ?? 0,
    },
    {
      backend,
      send: async reply => {
        replies.push(reply)
        for (const wake of wakeups.splice(0)) wake()
      },
      log: () => {},
      reclaimOrphan,
      ...options.judge === undefined ? {} : { judgment: () => options.judge },
      ...options.readSession === undefined ? {} : { readSession: options.readSession },
    },
  )
  return {
    jobs,
    replies,
    disposed,
    async next(kind, count = 1) {
      for (;;) {
        const matching = replies.filter(reply => reply.kind === kind)
        if (matching.length >= count) return matching[count - 1] as RunnerReply
        const { promise, resolve } = Promise.withResolvers<void>()
        wakeups.push(resolve)
        await promise
      }
    },
  }
}

/** One Onlyne entry, in the shape the runtime hands the coordinator. */
function entryOf(kind: string, body: string, meta: Record<string, unknown>, thread: string): Entry {
  return {
    seq: 1,
    thread_ref: { owner: 'urn:onlyne:agent:bot', id: thread },
    authenticated_author: 'urn:onlyne:agent:bot',
    message: {
      id: `msg-${kind}-${thread}`,
      sender: 'urn:onlyne:agent:bot',
      delivery_kind: kind,
      msg: body,
      meta: { data: meta },
    },
  } as unknown as Entry
}

/** One Onlyne entry with `meta.work` where the protocol defines it: top level of `meta`. */
function workEntry(kind: string, body: string, meta: Record<string, unknown>, thread: string): Entry {
  return {
    seq: 1,
    thread_ref: { owner: 'urn:onlyne:agent:bot', id: thread },
    authenticated_author: 'urn:onlyne:agent:bot',
    message: {
      id: `msg-${kind}-${thread}`,
      sender: 'urn:onlyne:agent:bot',
      delivery_kind: kind,
      msg: body,
      meta,
    },
  } as unknown as Entry
}

/** Submit one job on thread-1 and hold until the first run has answered `pr`. */
async function submitted(h: Harness): Promise<IssueJobView> {
  const view = h.jobs.submit({
    text: 'rename the parser helper',
    thread: { owner: 'urn:onlyne:agent:bot', id: 'thread-1' },
    requester: 'urn:onlyne:agent:bot',
  })
  await h.next('pr')
  return view
}

/**
 * Let the coordinator finish the turn it is on. Every backend here resolves
 * at once, so the run's remaining steps are microtasks.
 */
async function idle(h: Harness, jobId: string): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    if (h.jobs.list().find(job => job.id === jobId)?.state === 'idle') return
    await Promise.resolve()
  }
  throw new Error(`job ${jobId} never became idle`)
}

describe('close', () => {
  test('reclaims the checkout and the machine once, and answers closed', async () => {
    const h = harness()
    const view = await submitted(h)
    const { id } = view

    expect(await h.jobs.close(id)).toBe(true)
    expect(h.disposed).toEqual([id])
    expect(h.jobs.list().find(job => job.id === id)?.state).toBe('closed')

    const reply = await h.next('closed')
    expect(reply.body).toContain(view.worker)
    expect(reply.to).toBe('urn:onlyne:agent:bot')
    expect(reply.thread.id).toBe('thread-1')
    expect(reply.data).toEqual({
      job: id,
      worker: view.worker,
      machine: `omd-sandbox-scratch-${view.workerId}`,
      worktree: `/tmp/omd-close-test/${id}`,
      reclaimed: true,
    })
  })

  test('closing again answers closed and releases nothing a second time', async () => {
    const h = harness()
    const { id } = await submitted(h)

    await h.jobs.close(id)
    expect(await h.jobs.close(id)).toBe(true)
    expect(h.disposed).toEqual([id])
    expect(h.jobs.list().find(job => job.id === id)?.state).toBe('closed')
    await h.next('closed', 2)
  })

  test('an unknown id is refused without throwing', async () => {
    const h = harness()
    expect(await h.jobs.close('not-a-job')).toBe(false)
    expect(h.disposed).toEqual([])
  })

  test('a close entry names the worker from another thread', async () => {
    const h = harness()
    const view = await submitted(h)
    const { id, worker } = view

    h.jobs.acceptClose(entryOf('close', '', { worker }, 'another-thread'))
    const reply = await h.next('closed')

    expect(reply.thread.id).toBe('thread-1')
    expect(reply.data.worker).toBe(worker)
    expect(h.disposed).toEqual([id])
  })

  test('closing a worker whose job is gone reclaims the orphan machine', async () => {
    const reclaimed: string[] = []
    const h = harness(fakeBackend(), async worker => {
      reclaimed.push(worker)
      return { machine: 'omd-sandbox-issue-orphan1' }
    })
    const worker = 'onlyne://runner/issue/orphan1'

    h.jobs.acceptClose(entryOf('close', '', { worker }, 'another-thread'))
    const reply = await h.next('closed')

    expect(reclaimed).toEqual([worker])
    expect(reply.body).toContain('omd-sandbox-issue-orphan1')
    expect(reply.data.reclaimed).toBe(true)
    expect(h.disposed).toEqual([])
  })

  test('an unmatched orphan leaves the failed answer intact', async () => {
    const h = harness(fakeBackend(), async () => undefined)

    h.jobs.acceptClose(entryOf('close', '', { worker: 'onlyne://runner/issue/gone' }, 'another-thread'))
    const reply = await h.next('failed')

    expect(reply.body).toContain('no worker holds this thread')
  })

  test('a close entry that names no live worker says which are live', async () => {
    const h = harness()
    const view = await submitted(h)

    h.jobs.acceptClose(entryOf('close', '', { worker: 'onlyne://runner/issue/deadbeef' }, 'another-thread'))
    const reply = await h.next('failed')

    expect(reply.body).toContain('close: no worker holds this thread')
    expect(reply.body).toContain(view.worker)
    expect(h.disposed).toEqual([])
  })

  test('closing a running job stops it before the release', async () => {
    const fake = fakeBackend()
    const launched = Promise.withResolvers<'started'>()
    const slow: CodingAgentBackend = {
      ...fake.backend,
      launch: async (job: CodingAgentJob) => {
        launched.resolve('started')
        const stopped = Promise.withResolvers<void>()
        job.signal.addEventListener('abort', () => stopped.resolve(), { once: true })
        await stopped.promise
        throw new Error('aborted')
      },
    }
    const h = harness({ backend: slow, disposed: fake.disposed })
    const view = h.jobs.submit({
      text: 'work that never finishes',
      thread: { owner: 'urn:onlyne:agent:bot', id: 'thread-2' },
      requester: 'urn:onlyne:agent:bot',
    })
    await launched.promise

    expect(await h.jobs.close(view.id)).toBe(true)
    expect(fake.disposed).toEqual([view.id])
    // The stop is not a failure to report: the answer is the close.
    expect(h.replies.map(reply => reply.kind)).toEqual(['closed'])
  })
})

describe('work identity', () => {
  test('a second filing of one work unit joins the worker already holding it', async () => {
    const fake = fakeBackend()
    const h = harness(fake)

    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-42' },
    }, 'thread-1'))
    // The Bot files the same piece of work again from another chat.
    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-42' },
    }, 'thread-9'))

    const note = await h.next('note')
    const pr = await h.next('pr')

    // One job, one machine, and the second filing is told which worker holds it.
    expect(h.jobs.list()).toHaveLength(1)
    expect(fake.provisioned).toHaveLength(1)
    expect(note.thread.id).toBe('thread-9')
    expect(note.data).toMatchObject({
      worker: pr.data.worker,
      job: pr.data.job,
      work: { unit: 'ISSUE-42' },
      adopted: true,
    })
    expect(note.data.worker).toMatch(/^onlyne:\/\/runner\/issue\/[A-Za-z0-9]/)

    // The thread that filed second now reads the worker's answers too.
    await h.jobs.close(pr.data.job as string)
    const closed = await h.next('closed', 2)
    expect(closed.thread.id).toBe('thread-9')
    expect(h.replies.filter(reply => reply.kind === 'closed').map(reply => reply.thread.id))
      .toEqual(['thread-1', 'thread-9'])
  })

  test('a different attempt at one unit is a new job', async () => {
    const fake = fakeBackend()
    const h = harness(fake)

    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-42', attempt: 1 },
    }, 'thread-1'))
    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-42', attempt: 2 },
    }, 'thread-2'))

    await h.next('pr', 2)
    expect(h.jobs.list()).toHaveLength(2)
    expect(fake.provisioned).toHaveLength(2)
  })

  test('an approving review from another thread lands on the waiting worker', async () => {
    const fake = fakeBackend()
    const h = harness(fake)

    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-42' },
    }, 'thread-1'))
    const pr = await h.next('pr')
    const jobId = pr.data.job as string

    // The reviewer answers in a thread of its own and names no worker: the work
    // unit is the identity that crosses threads.
    h.jobs.acceptReview(entryOf('review', 'ship it', {
      work: { unit: 'ISSUE-42' },
      verdict: 'approve',
    }, 'thread-2'))

    const answer = await h.next('closed', 2)
    expect(fake.disposed).toEqual([jobId])
    expect(h.jobs.list().find(job => job.id === jobId)?.state).toBe('approved')
    expect(h.jobs.workers()).toEqual([])
    expect(answer.data).toMatchObject({
      job: jobId,
      state: 'approved',
      verdict: 'approve',
      reclaimed: true,
    })
    expect(h.replies.filter(reply => reply.kind === 'closed').map(reply => reply.thread.id))
      .toEqual(['thread-1', 'thread-2'])
    expect(fake.provisioned).toHaveLength(1)
  })

  test('an approving review that names the worker address lands from another thread', async () => {
    const fake = fakeBackend()
    const h = harness(fake)

    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {}, 'thread-1'))
    const pr = await h.next('pr')

    h.jobs.acceptReview(entryOf('review', '', {
      worker: pr.data.worker,
      verdict: 'approve',
    }, 'thread-2'))

    const answer = await h.next('closed', 2)
    expect(answer.data.state).toBe('approved')
    expect(fake.disposed).toEqual([pr.data.job as string])
  })

  test('a rejecting review from another thread runs the same checkout again', async () => {
    const fake = fakeBackend()
    const h = harness(fake)

    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-42' },
    }, 'thread-1'))
    await h.next('pr')

    h.jobs.acceptReview(entryOf('review', 'the --json flag is missing', {
      work: { unit: 'ISSUE-42' },
      verdict: 'reject',
    }, 'thread-2'))

    const again = await h.next('pr', 3)
    expect(fake.provisioned).toHaveLength(1)
    expect(fake.launches).toHaveLength(2)
    expect(again.thread.id).toBe('thread-2')
  })

  test('a review naming the worker still hits after the provider renamed the machine', async () => {
    const fake = fakeBackend()
    let provisions = 0
    const backend: CodingAgentBackend = {
      ...fake.backend,
      provision: async (job: CodingAgentJob) => {
        provisions++
        return {
          worktreePath: `/tmp/omd-renamed-test/${job.id}`,
          branch: job.branch,
          machine: 'renamed-box-7',
        }
      },
    }
    const h = harness({ backend, disposed: fake.disposed })

    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-42' },
    }, 'thread-1'))
    const pr = await h.next('pr')
    expect(pr.data.machine).toBe('renamed-box-7')

    h.jobs.acceptReview(entryOf('review', 'also cover the status command', {
      worker: pr.data.worker,
    }, 'thread-2'))

    const again = await h.next('pr', 3)
    expect(again.thread.id).toBe('thread-2')
    expect(provisions).toBe(1)
    expect(fake.launches).toHaveLength(2)
    await h.jobs.close(pr.data.job as string)
  })

  test('a review that names nothing is refused and lists the live workers', async () => {
    const h = harness()
    const view = await submitted(h)

    h.jobs.acceptReview(entryOf('review', 'looks fine', {}, 'thread-9'))
    const reply = await h.next('failed')

    expect(reply.body).toContain('review: no worker holds this thread')
    expect(reply.body).toContain(view.worker)
  })
})

describe('worker catalog', () => {
  test('lists a live worker under an address the machine name does not decide', async () => {
    const fake = fakeBackend()
    // A provider names machines its own way; the worker address is unaffected.
    const backend: CodingAgentBackend = {
      ...fake.backend,
      provision: async (job: CodingAgentJob) => ({
        worktreePath: `/tmp/omd-catalog-test/${job.id}`,
        branch: job.branch,
        machine: 'box-7',
      }),
    }
    const h = harness({ backend, disposed: fake.disposed })
    const view = h.jobs.submit({
      text: 'rename the parser helper',
      work: { unit: 'ISSUE-7', attempt: 2 },
      thread: { owner: 'urn:onlyne:agent:bot', id: 'thread-1' },
      requester: 'urn:onlyne:agent:bot',
    })
    await h.next('pr')
    await idle(h, view.id)

    const [record] = h.jobs.workers()
    expect(record).toMatchObject({
      worker: view.worker,
      workerId: view.workerId,
      jobId: view.id,
      machine: 'box-7',
      thread: 'urn:onlyne:agent:bot/thread-1',
      state: 'idle',
      workUnit: 'ISSUE-7',
      work: { unit: 'ISSUE-7', attempt: 2 },
    })
    expect(record?.worker).toBe(`onlyne://runner/issue/${view.workerId}`)
    expect(record?.startedAt).toBeGreaterThan(0)
    expect(record?.updatedAt).toBeGreaterThanOrEqual(record?.startedAt ?? 0)

    // The same unit and attempt submitted again is the same worker.
    const again = h.jobs.submit({
      text: 'rename the parser helper',
      work: { unit: 'ISSUE-7', attempt: 2 },
      thread: { owner: 'urn:onlyne:agent:bot', id: 'thread-3' },
      requester: 'urn:onlyne:agent:bot',
    })
    expect(again.worker).toBe(view.worker)
    expect(h.jobs.list()).toHaveLength(1)

    await h.jobs.close(view.id)
    expect(h.jobs.workers()).toEqual([])
  })
})

describe('the retain window', () => {
  test('a settled worker reclaims itself and answers closed', async () => {
    const h = harness(fakeBackend(), undefined, { settleReclaimMs: 5 })
    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-77' },
    }, 'thread-1'))
    const pr = await h.next('pr')
    const jobId = pr.data.job as string
    await idle(h, jobId)

    // The countdown is on the record a UI reads before anyone touches it.
    expect(h.jobs.workers()[0]?.reclaimAt).toBeGreaterThan(Date.now() - 1)

    const closed = await h.next('closed')
    expect(h.disposed).toEqual([jobId])
    expect(closed.data).toMatchObject({ job: jobId, reclaimed: true })
    expect(h.jobs.workers()).toEqual([])
  })

  test('a review inside the window cancels the countdown', async () => {
    const h = harness(fakeBackend(), undefined, { settleReclaimMs: 60_000 })
    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-78' },
    }, 'thread-1'))
    const pr = await h.next('pr')
    await idle(h, pr.data.job as string)
    expect(h.jobs.workers()[0]?.reclaimAt).toBeGreaterThan(Date.now())

    h.jobs.acceptReview(entryOf('review', 'the --json flag is missing', {
      work: { unit: 'ISSUE-78' },
      verdict: 'reject',
    }, 'thread-1'))
    // The run is already going by the time the review returns, and a worker
    // with work in it carries no countdown.
    expect(h.jobs.workers()[0]?.reclaimAt).toBeUndefined()

    await h.next('pr', 2)
    await h.jobs.close(pr.data.job as string)
    expect(h.disposed).toEqual([pr.data.job])
  })

  test('a change set larger than maxPatchBytes is never reclaimed on a timer', async () => {
    const fake = fakeBackend()
    const backend: CodingAgentBackend = {
      ...fake.backend,
      collect: async () => ({ patch: 'x'.repeat(2_000), patchBytes: 2_000, changedFiles: ['a.txt'] }),
    }
    const h = harness({ backend, disposed: fake.disposed }, undefined, { settleReclaimMs: 5 })
    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-83' },
    }, 'thread-1'))
    const pr = await h.next('pr')
    const jobId = pr.data.job as string
    await idle(h, jobId)

    // The answer carried no patch, so the checkout is the only copy of the
    // work: no countdown is armed, and nothing is released.
    expect(h.jobs.workers()[0]?.reclaimAt).toBeUndefined()
    expect(h.disposed).toEqual([])
    expect(h.jobs.workers()[0]?.state).toBe('idle')

    // An explicit close still reclaims it.
    await h.jobs.close(jobId)
    expect(h.disposed).toEqual([jobId])
  })
})

describe('the session feed', () => {
  /** A run that names its session, and a log behind it. */
  const records = [
    { type: 'user/message', time: 1_000, data: { content: [{ type: 'text', text: 'add the flag' }] } },
    { type: 'assistant/message', time: 2_000, data: { message: { content: [
      { type: 'reasoning', text: 'first read the parser' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    ] } } },
    { type: 'tool/call', time: 2_000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
    // The call id sits on the tool message, which is where dsh writes it.
    { type: 'tool/result', time: 2_100, data: {
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'parser.ts' }] },
    } },
  ]

  function busyBackend(): FakeBackend {
    const fake = fakeBackend()
    return {
      ...fake,
      backend: {
        ...fake.backend,
        launch: async () => ({ summary: 'the flag is in', stopReason: 'completed', childId: 'session-1' }),
      },
    }
  }

  test('a worker reports its session and serves the summarized log', async () => {
    const h = harness(busyBackend(), undefined, {
      readSession: async id => id === 'session-1' ? records : undefined,
    })
    h.jobs.acceptIssue(workEntry('issue', 'add the --json flag', {
      work: { unit: 'ISSUE-80' },
    }, 'thread-1'))
    const pr = await h.next('pr')
    await idle(h, pr.data.job as string)

    const [record] = h.jobs.workers()
    expect(record?.session).toBe('session-1')
    const answer = await h.jobs.readEvents(record?.worker ?? '')
    if (answer.kind !== 'feed') throw new Error(`no feed: ${answer.reason}`)
    expect(answer.value.worker).toBe(record?.worker)
    expect(answer.value.state).toBe('idle')
    expect(answer.value.truncated).toBe(false)
    expect(answer.value.events.map(event => event.kind)).toEqual(['user', 'reasoning', 'tool', 'result'])
    expect(answer.value.events[0]).toMatchObject({ role: 'user', text: 'add the flag' })
    expect(answer.value.events[2]).toMatchObject({ role: 'assistant', tool: 'bash', args: '{"command":"ls"}' })
    expect(answer.value.events[3]).toMatchObject({ role: null, tool: 'bash', result: 'parser.ts' })
    expect(answer.value.events[1]?.at).toBe(2_000)
  })

  test('an unknown worker and a missing log are both refused with a reason', async () => {
    const h = harness(busyBackend(), undefined, { readSession: async () => undefined })
    h.jobs.acceptIssue(workEntry('issue', 'add the --json flag', {
      work: { unit: 'ISSUE-81' },
    }, 'thread-1'))
    const pr = await h.next('pr')
    await idle(h, pr.data.job as string)

    const unknown = await h.jobs.readEvents('onlyne://runner/issue/beefcafe')
    expect(unknown.kind).toBe('missing')
    if (unknown.kind !== 'missing') throw new Error('an unknown worker answered a feed')
    expect(unknown.reason).toContain('onlyne://runner/issue/beefcafe')

    const answer = await h.jobs.readEvents(pr.data.worker as string)
    expect(answer.kind).toBe('missing')
    if (answer.kind !== 'missing') throw new Error('a worker with no stored log answered a feed')
    expect(answer.reason).toContain('session-1')
  })

  test('a worker whose agent has not started answers an empty feed with a note', async () => {
    const fake = fakeBackend()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const backend: CodingAgentBackend = {
      ...fake.backend,
      launch: async () => {
        started.resolve()
        await release.promise
        return { summary: 'the flag is in', stopReason: 'completed', childId: 'session-2' }
      },
    }
    const h = harness({ backend, disposed: fake.disposed }, undefined, { readSession: async () => undefined })
    const view = h.jobs.submit({
      text: 'add the --json flag',
      work: { unit: 'ISSUE-82' },
      thread: { owner: 'urn:onlyne:agent:bot', id: 'thread-1' },
      requester: 'urn:onlyne:agent:bot',
    })
    await started.promise

    // The startup window: accepted, provisioning, no coding agent yet.
    expect(h.jobs.workers()[0]?.state).toBe('running')
    expect(h.jobs.workers()[0]?.session).toBeUndefined()
    const waiting = await h.jobs.readEvents(view.worker)
    if (waiting.kind !== 'feed') throw new Error(`a starting worker was refused: ${waiting.reason}`)
    expect(waiting.value).toEqual({
      worker: view.worker,
      state: 'running',
      events: [],
      truncated: false,
      note: 'the coding-agent session has not started yet',
    })

    release.resolve()
    await h.next('pr')
    await idle(h, view.id)
    // Once the run has its session, the same address answers the session path
    // again: a session without a stored log stays a refusal, not an empty feed.
    expect(h.jobs.workers()[0]?.session).toBe('session-2')
    const after = await h.jobs.readEvents(view.worker)
    expect(after.kind).toBe('missing')
  })

  test('a review run exposes its own session, not the finished one', async () => {
    const fake = fakeBackend()
    const secondStarted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let live: string | undefined
    let runs = 0
    const backend: CodingAgentBackend = {
      ...fake.backend,
      sessionOf: () => live,
      launch: async () => {
        runs++
        if (runs === 1) return { summary: 'first pass', stopReason: 'completed', childId: 'session-old' }
        live = 'session-new'
        secondStarted.resolve()
        await release.promise
        return { summary: 'second pass', stopReason: 'completed', childId: 'session-new' }
      },
    }
    const h = harness({ backend, disposed: fake.disposed })
    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-84' },
    }, 'thread-1'))
    const pr = await h.next('pr')
    await idle(h, pr.data.job as string)
    expect(h.jobs.workers()[0]?.session).toBe('session-old')

    h.jobs.acceptReview(entryOf('review', 'add the flag', {
      work: { unit: 'ISSUE-84' },
      verdict: 'reject',
    }, 'thread-1'))
    await secondStarted.promise
    // The backend mints the new session before `launch` returns for it, and the
    // record must follow the run that is going, not the one that finished.
    expect(h.jobs.workers()[0]?.session).toBe('session-new')

    release.resolve()
    await h.next('pr', 2)
    await h.jobs.close(pr.data.job as string)
    expect(h.disposed).toEqual([pr.data.job])
  })
})

describe('answer text', () => {
  test('a change set behind a non-error stop still carries its diagnostic', async () => {
    const fake = fakeBackend()
    const backend: CodingAgentBackend = {
      ...fake.backend,
      launch: async () => ({
        summary: 'the change is in the checkout',
        // Not `error`: the run produced work, so it is reported as a change set.
        stopReason: 'aborted',
        diagnostic: 'the provider closed the stream after the last tool result',
      }),
    }
    const h = harness({ backend, disposed: fake.disposed })
    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-85' },
    }, 'thread-1'))
    const answer = await h.next('pr')

    expect(answer.body).toContain('stop: aborted')
    expect(answer.body).toContain('diagnostic: the provider closed the stream after the last tool result')
    expect(answer.data.diagnostic).toBe('the provider closed the stream after the last tool result')
  })

  test('a stop:error is failed with its diagnostic, and the judge is never asked', async () => {
    const fake = fakeBackend()
    const asked: string[] = []
    const judge: IssueJudge = {
      available: () => true,
      judge: async () => {
        asked.push('asked')
        // The answer a semantic judge would give about an empty report.
        return { answers: { outcome: { choice: 'accomplished', confidence: 0.99 } } }
      },
    }
    const backend: CodingAgentBackend = {
      ...fake.backend,
      launch: async () => ({
        summary: '',
        stopReason: 'error',
        diagnostic: 'llm-pi-ai: no credential for provider route "magpie" (MISSING_CREDENTIAL)',
      }),
    }
    const h = harness({ backend, disposed: fake.disposed }, undefined, { judge, judgeResults: true })
    h.jobs.acceptIssue(workEntry('issue', 'rename the parser helper', {
      work: { unit: 'ISSUE-86' },
    }, 'thread-1'))
    const answer = await h.next('failed')

    // An execution error is mechanically a failed run: no judge is consulted,
    // and no `pr` is ever delivered for it.
    expect(asked).toEqual([])
    expect(h.replies.map(reply => reply.kind)).toEqual(['failed'])
    expect(answer.body).toContain('stopped on a provider error')
    expect(answer.body).toContain('diagnostic: llm-pi-ai: no credential')
    expect(answer.data).toMatchObject({
      stop: 'error',
      diagnostic: 'llm-pi-ai: no credential for provider route "magpie" (MISSING_CREDENTIAL)',
    })
    expect(h.jobs.list()[0]?.failure).toContain('MISSING_CREDENTIAL')
  })
})

describe('the failure row', () => {
  test('a recorded provider failure is a row a reader can see', () => {
    const { events, truncated } = summarizeSession([
      { type: 'user/message', time: 1_784_000_000_000, data: {
        content: [{ type: 'text', text: 'build the file' }],
      } },
      { type: 'turn/end', time: 1_784_000_015_000, data: {
        turn: 1,
        reason: {
          kind: 'error',
          error: { message: 'llm-pi-ai: no credential for provider route "magpie"', code: 'MISSING_CREDENTIAL' },
        },
      } },
    ])

    expect(truncated).toBe(false)
    expect(events.map(event => event.kind)).toEqual(['user', 'result'])
    expect(events[1]).toMatchObject({
      at: 1_784_000_015_000,
      role: null,
      tool: null,
      result: 'MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "magpie"',
    })
    // A turn that ended cleanly is not a failure row.
    expect(summarizeSession([
      { type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]).events).toEqual([])
  })
})
