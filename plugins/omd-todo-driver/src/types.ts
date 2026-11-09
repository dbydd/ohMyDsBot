/**
 * Structural vocabulary of the pieces `omd-todo-driver` consumes from other
 * packages without depending on them: the `judgment` service and the message
 * source it owns. Declared here so a composition can mount this plugin with a
 * different judge implementation, and so the todo plugin's migration does not
 * leak a second copy of the judge contract into this package.
 *
 * @module omd-todo-driver/types
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** The three verdict labels; every other answer shape is a no-nudge. */
export type Verdict = 'continue' | 'wait' | 'done'

/** One choice question, rendered by the judge backend. */
export interface VerdictQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<Verdict, string>
}

/** A choice answer with the full distribution the driver logs as its reason. */
export interface VerdictAnswer {
  type: 'choice'
  choice: Verdict
  probabilities: Record<string, number>
  confidence: number
}

/** The slice of `ctx.judgment` this plugin calls. */
export interface JudgmentService {
  available(): boolean
  judge(
    request: { state: unknown; questions: { verdict: VerdictQuestion } },
    options?: { signal?: AbortSignal },
  ): Promise<{ answers: { verdict: VerdictAnswer } }>
}

/** Optional `ctx.todoOrder` face the driver consults before reading the tree. */
export interface TodoOrderService {
  /** Bring the stored order up to date; single-flight and idempotent. */
  ensureFresh(session: Session, signal?: AbortSignal): Promise<void>
}
