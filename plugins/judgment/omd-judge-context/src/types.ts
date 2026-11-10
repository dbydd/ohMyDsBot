/**
 * Vocabulary of one assembled judge call: the purpose, the budgeted state the
 * judge sees, and the caller-owned facts that domain plugins contribute.
 *
 * The state is plain JSON. It deliberately excludes the system prompt, tool
 * schemas, spill bodies, and image bytes: a judge needs the decision surface,
 * not the model's whole request.
 *
 * @module omd-judge-context/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** What the judge is deciding. The purpose selects the constant task text. */
export type JudgePurpose = 'todo-continuation' | 'visualization'

/** One active todo node as the judge sees it, with its 1-based tree path. */
export interface JudgeTodoNode {
  /** 1-based path within the todo tree, e.g. `2` or `1.2`. */
  path: string
  /** Short imperative line. */
  content: string
  /**
   * Single tri-state: `active` is being pushed now, `inactive` is planned but
   * parked, `completed` is done. The old `status`/`active` pair no longer exists.
   */
  state: string
  /** What is true once the step is done; empty when the writer omitted it. */
  goal?: string
  /** Why the step exists; empty when the writer omitted it. */
  explanation?: string
  /** Smaller steps this one owns. */
  children?: JudgeTodoNode[]
}

/** One background job that is still running or stopping. */
export interface JudgeWaitingJob {
  kind: string
  label: string
  status: string
  progress?: string
}

/** One live subagent the session is waiting on. */
export interface JudgeWaitingChild {
  session: string
  status: string
}

/** One unanswered user question call. */
export interface JudgeWaitingQuestion {
  state: string
  questions: readonly string[]
}

/** Facts a domain plugin contributes; every field is optional and omitted when unknown. */
export interface JudgeFacts {
  /** Active, unfinished todo nodes with their tree paths. */
  todos?: readonly JudgeTodoNode[]
  /** Events that can return on their own, which is what makes a stop a wait. */
  waiting?: {
    jobs?: readonly JudgeWaitingJob[]
    children?: readonly JudgeWaitingChild[]
    user_questions?: readonly JudgeWaitingQuestion[]
  }
}

/** One tool call the judge sees, after abnormal-first ordering and budgeting. */
export interface JudgeToolCall {
  /** `ok` completed cleanly; `unfinished` has no result; `error` returned `isError`. */
  state: 'ok' | 'unfinished' | 'error'
  name: string
  /** Whitespace-collapsed argument text, clipped. */
  arguments: string
  /** First result line, clipped; absent for an unfinished call. */
  result?: string
}

/** The budgeted state one judge call is made over. */
export interface JudgeContextState {
  /** Active, unfinished todo tree; absent for a purpose that does not judge todo. */
  todo?: readonly JudgeTodoNode[]
  /** Entries dropped from the todo tree by the 30-node cap or later trimming. */
  todo_omitted?: number
  waiting?: {
    jobs?: readonly JudgeWaitingJob[]
    children?: readonly JudgeWaitingChild[]
    user_questions?: readonly JudgeWaitingQuestion[]
  }
  /** Last human message, clipped; absent when the session has none. */
  last_user_message?: string
  /** Up to three newest assistant messages, oldest first. */
  assistant_messages: readonly string[]
  /** Tool calls that fit the remaining budget, abnormal ones first. */
  tool_calls: readonly JudgeToolCall[]
  /** Calls omitted from `tool_calls`; zero when everything fit. */
  omitted_tool_calls: number
  /** Plain-language notes, e.g. that older calls were left out. */
  notes?: readonly string[]
}

/** One assembled judge call: the constant task text plus the budgeted state. */
export interface JudgeContext {
  purpose: JudgePurpose
  /** Constant task statement, placed in the judge's question rather than the state. */
  task: string
  /** Budgeted state; the only material the verdict may rest on. */
  state: JudgeContextState
  /** Approximate token count of `state`, measured with the same estimator the budget uses. */
  tokens: number
}

/** The session read the assembler needs; `ctx.sessionQuery` satisfies it. */
export interface JudgeContextQuery {
  readSession(sessionId: SessionId): Promise<{
    session: unknown
    events: readonly unknown[]
  }>
}

/** One request to assemble a judge context. */
export interface BuildJudgeContextRequest {
  /** Live or persisted session to read. Only its id is used. */
  session: { readonly id: SessionId }
  /** Token budget for `state`; fixed sections are trimmed before the todo tree. */
  budget: number
  purpose: JudgePurpose
  /** Constant task text; omitted uses the purpose's built-in text. */
  task?: string
  /** Domain facts the caller already has. */
  facts?: JudgeFacts
}
