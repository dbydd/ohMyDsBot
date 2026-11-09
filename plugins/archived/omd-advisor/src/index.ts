/**
 * `omd-advisor` — a review pass whose suggestions reach the primary agent only
 * after they survive an admission guard.
 *
 * Ported from omp's `advisor/` (review plus `AdvisorEmissionGuard`). dsh has no
 * first-class judge role, so this package consumes the optional
 * `ctx.judgment` service that `plugins/omd-judgment` mounts. At each turn
 * boundary the judge classifies the agent's last answer into
 * `nit` / `concern` / `blocker`; `guard.ts` then drops the empty, the
 * content-free, the repeated, and the over-budget before anything is injected.
 *
 * Delivery follows omp's channel split. A `concern` or `blocker` steers the
 * agent now and arms an immune window; a `nit` is an aside. While the window is
 * open, further `concern`s are downgraded to non-interrupting asides — a
 * `blocker` is exempt, because it means the agent handed off broken work. Every
 * aside is injected through `agent.inject` and tagged `(advisory)`, which never
 * wakes an idle driver.
 *
 * A turn whose newest user message is one of this package's advisories is not
 * reviewed: without that fence an interrupting advisory re-opens a step, the
 * new answer is classified again, and the advisor talks to itself.
 *
 * The package is inert when disabled: `apply` returns before registering any
 * listener, so a profile that leaves `enabled: false` pays nothing. It is
 * equally inert when the judgment service is absent, unavailable, or its call
 * fails — the advisor is a convenience, and a broken convenience must not
 * change how the session behaves.
 *
 * The `model` setting is recorded intent for the review candidate, not a
 * selector: candidate choice belongs to `omd-judgment`'s own `candidates`
 * list, and the service exposes no per-call candidate override.
 *
 * Named exports only: a `default` export makes the Loader discard this whole
 * namespace and every injection with it.
 *
 * @module omd-advisor
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

import { guardSuggestions, normalizeSuggestion, type GuardHistoryEntry, type GuardResult } from './guard.ts'
import type { ChoiceQuestion, JudgmentService } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Judgment service, when `plugins/omd-judgment` is mounted. Optional: always read it with `ctx.get`. */
    judgment: JudgmentService
  }
}

/**
 * This package's own message-source kind. Session format v4 refuses the retired
 * `plugin` wrapper, and every producer declares its kind in its own module, so
 * the advisory carries `omd-advisor` and a reader can recognise it without
 * parsing the text.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'omd-advisor': { kind: 'omd-advisor' } & ContextFormed
  }
}

export { guardSuggestions, normalizeSuggestion } from './guard.ts'
export type * from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-advisor'

/**
 * Services this plugin needs before its fiber activates. `judgment` is
 * deliberately absent: the advisor degrades to silence without it rather than
 * keeping the profile from starting.
 */
export const inject = ['sessionProjections']

/** The three severity labels, in rank order; the index is the rank `guard.ts` compares. */
type SeverityLabel = 'nit' | 'concern' | 'blocker'

/** The same three labels as an array; `indexOf` maps a judge answer to its rank. */
const SEVERITY_LABELS: readonly SeverityLabel[] = ['nit', 'concern', 'blocker']

/** Rank of `concern`: interrupts until the immune window opens. */
const SEVERITY_CONCERN = 2

/** Rank of `blocker`: exempt from the immune window and from both budgets. */
const SEVERITY_BLOCKER = 3

/** Deployment settings for the advisor. */
export interface Config {
  /** Run the advisor. When `false` the plugin registers nothing at all. */
  enabled: boolean
  /** Review-candidate label recorded for diagnostics; candidate choice belongs to `omd-judgment`. */
  model: string
  /** Primary turns after an interrupting advisory during which further concerns are downgraded to asides. */
  immuneTurns: number
  /** Non-`blocker` advisories delivered per primary turn. */
  maxPerTurn: number
  /** Non-`blocker` advisories delivered across one session. */
  hardCap: number
  /** Judge confidence below which a classification counts as "no advice"; read per review. */
  minConfidence: Volatile<number>
  /** Longest excerpt of the flagged answer quoted back in the advisory; read per review. */
  excerptChars: Volatile<number>
}

/** Schemastery configuration for the advisor. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false).description(
    'Run the advisor. When false the plugin registers no listener and consumes no judgment call.',
  ),
  model: z.string().default('slow').description(
    'Review-candidate label recorded for diagnostics. Candidate selection is owned by omd-judgment\'s candidates list.',
  ),
  immuneTurns: z.number().min(0).default(3).description(
    'After an interrupting advisory, deliver further concerns as non-interrupting asides for this many primary turns. Blockers are exempt.',
  ),
  maxPerTurn: z.number().min(1).default(4).description(
    'Non-blocker advisories allowed per primary turn.',
  ),
  hardCap: z.number().min(1).default(32).description(
    'Non-blocker advisories allowed across one session.',
  ),
  minConfidence: z.number().min(0).max(1).default(0.6)
    .volatile()
    .description('Judge confidence below which the classification is treated as no advice.'),
  excerptChars: z.number().step(1).min(1).default(200)
    .volatile()
    .description('Longest excerpt of the flagged answer quoted back in the advisory.'),
})

/**
 * The judgment question the review asks. A `choice` answer is the only shape
 * that yields both a label and a calibrated confidence, which is what the
 * routing decision needs; the criteria double as the reviewer's vocabulary.
 */
const REVIEW_QUESTIONS: { review: ChoiceQuestion<SeverityLabel> } = {
  review: {
    type: 'choice',
    instructions:
      'Read the assistant answer below as a reviewer watching another coding agent. Is there one concrete problem the agent has not addressed? Choose exactly one severity: "nit" for cosmetic or stylistic matters that leave the work correct, "concern" when the work may be wrong or incomplete, "blocker" when the agent handed off broken or unexercised work.',
    criteria: {
      nit: 'Cosmetic or stylistic; the work is correct either way.',
      concern: 'The work may be wrong or incomplete in a way worth interrupting for.',
      blocker: 'The agent handed off broken or unexercised work.',
    },
  },
}

/** One agent's advisor bookkeeping. */
interface AdvisorLane {
  /** Advisories accepted so far, oldest first; the guard's dedupe and budget input. */
  readonly history: GuardHistoryEntry[]
  /** Turn of the last interrupting delivery, if any. */
  immuneStart: number | undefined
  /** Primary turns this agent has completed. */
  completedTurns: number
}

/**
 * Mount the advisor for every agent session in this profile.
 * @param ctx - the entry fiber's context, carrying the projection registry.
 * @param config - the profile row's configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (config.hardCap < config.maxPerTurn) {
    throw new Error(
      `omd-advisor: hardCap (${String(config.hardCap)}) is below maxPerTurn (${String(config.maxPerTurn)}); the session cap would silence the advisor after its first turn.`,
    )
  }

  /** Advisor state per agent id, created on `agent/created` and dropped on disposal. */
  const lanes = new Map<SessionId, AdvisorLane>()

  ctx.on('agent/created', ({ agent }) => {
    lanes.set(agent.id, { history: [], immuneStart: undefined, completedTurns: 0 })
    return undefined
  })

  ctx.on('agent/disposed', ({ agent }) => {
    lanes.delete(agent.id)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const lane = lanes.get(agent.id)
    if (lane === undefined) return
    lane.completedTurns += 1
    if (startedByAdvisory(agent)) return
    await review(ctx, agent, lane, turn, config)
  })
}

/**
 * Ask the judge to classify the agent's last answer, then admit the resulting
 * advisory and route it.
 *
 * Every failure path is silent: a missing service, an unavailable candidate, a
 * rejected call, or an answer that is not one of the three labels leaves the
 * session exactly as it was.
 *
 * The review is awaited inside `agent/turn-stopping` on purpose. That listener
 * is the one hook whose verdict the turn boundary honours — a `steer` issued
 * there re-opens the step and the turn does not close — so an interrupting
 * advisory has to be decided before the boundary commits.
 *
 * @param ctx - the plugin context, used to resolve the optional judgment service.
 * @param agent - the agent whose turn just stopped.
 * @param lane - the agent's advisor bookkeeping.
 * @param turn - the turn about to close.
 * @param config - deployment settings.
 */
async function review(
  ctx: Context,
  agent: Agent,
  lane: AdvisorLane,
  turn: number,
  config: Config,
): Promise<void> {
  const judgment = ctx.get('judgment')
  if (judgment === undefined || !judgment.available()) return

  const answer = lastAnswerText(agent)
  if (answer === undefined) return

  let severity: number
  try {
    const result = await judgment.judge({ state: answer, questions: REVIEW_QUESTIONS })
    if (result.answers.review.confidence < config.minConfidence.get()) return
    const index = SEVERITY_LABELS.indexOf(result.answers.review.choice)
    if (index < 0) return
    severity = index + 1
  } catch {
    return
  }
  const label = SEVERITY_LABELS[severity - 1]
  if (label === undefined) return

  const excerptChars = config.excerptChars.get()
  const excerpt = answer.length > excerptChars ? `${answer.slice(0, excerptChars - 1)}…` : answer
  const text = `Reviewer flagged this answer as ${label}: "${excerpt}"`

  const admitted: GuardResult = guardSuggestions([{ text, severity, turn }], lane.history, {
    maxPerTurn: config.maxPerTurn,
    hardCap: config.hardCap,
  })
  if (admitted.accept.length === 0) return

  const immuneOpen = lane.immuneStart !== undefined
    && lane.completedTurns < lane.immuneStart + config.immuneTurns
  const interrupting = severity >= SEVERITY_CONCERN && !(immuneOpen && severity !== SEVERITY_BLOCKER)
  deliver(agent, text, severity, interrupting)

  lane.history.push({ key: normalizeSuggestion(text), severity, turn })
  if (interrupting) lane.immuneStart = lane.completedTurns
}

/**
 * Whether the agent's newest user message is an advisory this package wrote.
 * @param agent - the agent whose session is read.
 * @returns `true` when the last user message carries this package's source kind.
 */
function startedByAdvisory(agent: Agent): boolean {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    return event.data.source.kind === 'omd-advisor'
  }
  return false
}

/**
 * Read the newest assistant message's visible text off the session log.
 * @param agent - the agent whose session is read.
 * @returns the concatenated text blocks, or `undefined` when the agent has not answered yet.
 */
function lastAnswerText(agent: Agent): string | undefined {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const lines: string[] = []
    for (const block of event.data.message.content) {
      if (block.type === 'text') lines.push(block.text)
    }
    const text = lines.join('\n').trim()
    return text === '' ? undefined : text
  }
  return undefined
}

/**
 * Hand one accepted advisory to the agent.
 *
 * An interrupting advisory steers the nearest step; an aside is injected as
 * non-waking context and carries the `(advisory)` tag that marks it as advice
 * rather than an order.
 * @param agent - the agent that receives the advisory.
 * @param text - the advisory body.
 * @param severity - resolved severity rank.
 * @param interrupting - whether the advisory should reach the nearest step now.
 */
function deliver(agent: Agent, text: string, severity: number, interrupting: boolean): void {
  const label = SEVERITY_LABELS[severity - 1] ?? 'concern'
  const tag = interrupting ? '' : ' (advisory)'
  const body = `<advisory severity="${label}">${text}${tag}</advisory>`
  const message = createUserMessage({
    content: [{ type: 'text', text: body }],
    source: { kind: 'omd-advisor', form: 'notice', summary: boundContextSummary(body) },
  })
  if (interrupting) agent.steer(message)
  else agent.inject(message)
}
