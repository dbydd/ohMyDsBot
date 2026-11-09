/**
 * `omd-judge-context` — the one budgeted context every judge call is built from.
 *
 * It is a library, not a mounted plugin: {@link buildJudgeContext} reads one
 * session through `ctx.sessionQuery` and delegates the assembly to the pure
 * {@link assembleJudgeContext}. The purpose decides the constant task text;
 * callers that judge something this package does not know yet pass their own,
 * so the shared section policy and budget stay in one place.
 *
 * @module omd-judge-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import { assembleJudgeContext } from './assemble.ts'
import type { BuildJudgeContextRequest, JudgeContext } from './types.ts'

export { assembleJudgeContext, DEFAULT_TASKS, estimateTokens, TODO_CONTINUATION_TASK } from './assemble.ts'
export type * from './types.ts'

/**
 * Assemble one judge context from a live or persisted session.
 *
 * The session is read through `ctx.sessionQuery.readSession`, never through a
 * cached projection: a verdict at a stop boundary must see the log as it
 * stands, including the assistant message that just closed the step.
 * @param ctx - context whose `sessionQuery` serves the read.
 * @param request - session, budget, purpose, task override, and caller facts.
 * @returns the task text plus the budgeted state.
 * @throws when no session-query service is mounted, or the purpose has no task.
 */
export async function buildJudgeContext(
  ctx: Context,
  request: BuildJudgeContextRequest,
): Promise<JudgeContext> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new Error('omd-judge-context: ctx.sessionQuery is not mounted; a judge context needs the session log')
  }
  const snapshot = await query.readSession(request.session.id)
  return assembleJudgeContext({
    header: snapshot.session,
    events: snapshot.events,
    budget: request.budget,
    purpose: request.purpose,
    ...(request.task === undefined ? {} : { task: request.task }),
    ...(request.facts === undefined ? {} : { facts: request.facts }),
  })
}
