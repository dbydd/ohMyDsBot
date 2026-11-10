/**
 * The seam between a job and whatever runs the coding agent.
 *
 * A job has four moments and each one is a method here: get a checkout the
 * agent may destroy (`provision`), hand it the work (`launch`), read what it
 * left behind (`collect`), and give the checkout back (`dispose`). The runner
 * owns the queue, the thread and the reply; a backend owns only those four
 * steps, so a second backend — a container, a remote coding service, a
 * different agent runtime — is a second implementation of this interface and
 * nothing else.
 *
 * The implementation in `backends/dsh-agent.ts` is the MVP: a git worktree from
 * `ctx.worktreeAlloc` and one dsh agent whose session is created in it.
 *
 * @module omd-issue-runner/backend
 */

import type { WorkRef } from './types.ts'

/** One isolated workspace handed to a coding agent. */
export interface Provisioned {
  /** Absolute directory the agent runs in, and where the change set is read. */
  readonly worktreePath: string
  /** Name the workspace carries; the runner reports it back. */
  readonly branch: string
  /**
   * Machine the agent's commands run in, when the backend isolates them in
   * one. Absent means commands ran on the host.
   */
  readonly machine?: string
  /** The lease that machine was granted under, when it was leased. */
  readonly leaseId?: string
  /**
   * Interactive view of that machine's desktop, when it has one. A human opens
   * it to watch the run and to take the mouse and keyboard over.
   */
  readonly desktopUrl?: string
}

/** What one coding-agent run reported. */
export interface RunResult {
  /** The agent's own closing text, flattened. */
  readonly summary: string
  /**
   * Backend reason the run stopped — `completed`, `aborted`, `error`,
   * `max-tokens`, or a backend-specific value. The runner reports it verbatim
   * instead of guessing whether the work is finished.
   */
  readonly stopReason: string
  /** Provider-authored failure detail, present on a non-`completed` run. */
  readonly diagnostic?: string
  /** The agent session the backend started, when it has a durable identity. */
  readonly childId?: string
}

/** What a job's checkout holds after a run. */
export interface RunCollection {
  /** Replayable Git patch text of everything the run changed, untracked files included. */
  readonly patch: string
  /** Size of `patch` in UTF-8 bytes. */
  readonly patchBytes: number
  /** Workspace-relative paths the patch touches, sorted. */
  readonly changedFiles: readonly string[]
}

/** The work one job hands a backend. */
export interface CodingAgentJob {
  /** Job identity; also the branch suffix. */
  readonly id: string
  /**
   * The worker's own id. A machine is named after this; nothing derives the
   * worker address back from the machine name.
   */
  readonly workerId: string
  /** Short label taken from the issue's first line. */
  readonly title: string
  /** The issue body, verbatim. */
  readonly issue: string
  /**
   * Review notes that arrived before this run, oldest first. Each launch starts
   * a fresh agent, so the prompt has to carry the whole history.
   */
  readonly notes: readonly string[]
  /** Branch the isolated checkout carries. */
  readonly branch: string
  /** Absolute directory the isolated checkout is cut from. */
  readonly source: string
  /** The work unit this job was filed under, when the issue named one. */
  readonly work?: WorkRef
  /** `owner/id` of the Onlyne thread this job answers, for the prompt. */
  readonly thread?: string
  /** Node that filed the issue; the backend needs it to pick a parent session. */
  readonly requester?: string
  /** Cancellation for the job: aborting must stop the agent, not the runner. */
  readonly signal: AbortSignal
}

/**
 * One way of running a coding agent against an isolated checkout.
 *
 * Implementations keep their own per-job state, keyed by {@link CodingAgentJob.id}:
 * the interface passes a job description in and receives plain results, so the
 * allocator handle, the agent session or a container id never enter the
 * runner's bookkeeping.
 */
export interface CodingAgentBackend {
  /** Name used in diagnostics and in the `issueRunner` service view. */
  readonly name: string
  /**
   * Create the checkout the run may destroy.
   * @param job - the job description.
   * @returns the directory and the branch name to report.
   */
  provision(job: CodingAgentJob): Promise<Provisioned>
  /**
   * Hand the job to the coding agent and wait for the run to settle.
   *
   * Called more than once for the same job when review notes arrive: the same
   * checkout, a fresh agent.
   * @param job - the job description, carrying every note delivered so far.
   * @param provisioned - what {@link provision} returned for this job.
   * @returns the run's closing summary and stop reason.
   */
  launch(job: CodingAgentJob, provisioned: Provisioned): Promise<RunResult>
  /**
   * Read what the run changed.
   * @param job - the job description.
   * @returns the patch, its size, the files it touches and the branch's commits.
   */
  collect(job: CodingAgentJob): Promise<RunCollection>
  /**
   * The coding-agent session this job's current run is in, when the backend
   * has minted one.
   *
   * Read on demand, so a watcher can open the worker's event feed while the
   * agent is still working instead of only after the answer. Optional: a
   * backend that cannot name its session before `launch` settles simply
   * reports it through {@link RunResult.childId} afterwards.
   * @param job - the job description.
   * @returns the session id, or undefined before a session exists.
   */
  sessionOf?(job: CodingAgentJob): string | undefined
  /**
   * Give the checkout back, discarding whatever is still uncommitted in it.
   *
   * Called when a job is cancelled or the plugin unloads; a finished job keeps
   * its checkout so a human can read the change set.
   * @param job - the job description.
   */
  dispose(job: CodingAgentJob): Promise<void>
}

/**
 * The prompt template the runner ships with. Placeholders are replaced by
 * {@link renderIssuePrompt}; a backend that renders its own prompt ignores it.
 */
export const DEFAULT_ISSUE_PROMPT = [
  'You are a coding agent working on an isolated checkout of branch {{branch}}.',
  '',
  'This task came from the Onlyne thread {{thread}}. Work in the current directory only;',
  'do not touch any other checkout.',
  '',
  '## Issue',
  '',
  '{{issue}}',
  '',
  '## Rules',
  '',
  '- Finish the issue; do not refactor beyond it.',
  '- Leave the changes in the working tree. Do not push, and do not touch other branches.',
  '- End with a short summary: what changed, what you could not verify, and anything the reviewer must know.',
].join('\n')

/**
 * Fill the configured template.
 *
 * Only the three placeholders are replaced; the values are inserted verbatim,
 * so an issue body containing `{{branch}}` is not substituted again.
 *
 * @param template - prompt template with `{{issue}}`, `{{thread}}`, `{{branch}}`.
 * @param values - the substitution values.
 * @returns the prompt text.
 */
export function renderIssuePrompt(
  template: string,
  values: { readonly issue: string; readonly thread: string; readonly branch: string },
): string {
  return template
    .replaceAll('{{issue}}', values.issue)
    .replaceAll('{{thread}}', values.thread)
    .replaceAll('{{branch}}', values.branch)
}

/**
 * The issue plus every review note, as one task text.
 *
 * A fresh agent cannot read the thread, so the notes are part of its prompt
 * instead of being delivered as conversation.
 *
 * @param job - the job whose text is wanted.
 * @returns the issue body, followed by the notes when there are any.
 */
export function taskText(job: CodingAgentJob): string {
  if (job.notes.length === 0) return job.issue
  const notes = job.notes.map((note, index) => `${index + 1}. ${note.trim()}`).join('\n')
  return [job.issue.trim(), '', '## Review notes from earlier rounds', '', notes].join('\n')
}
