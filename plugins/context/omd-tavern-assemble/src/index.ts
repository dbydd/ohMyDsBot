/**
 * `omd-tavern-assemble` — the host half that sends the context-tavern
 * document into the model request.
 *
 * Every assembly, the plugin reads the tavern document for the session's
 * working directory, runs the deterministic pre-selection (`select.ts`),
 * settles the suspended secondary-key candidates with one batched judge call
 * (`decide.ts`), and renders two prompt sections (`assemble.ts`): the
 * lorebook blocks and the Author's Note. The sections are registered with
 * fixed placements in the system-prompt registry; their text is filled in by
 * the per-agent `system-prompt/assemble` waterfall, because the judge call is
 * asynchronous and a `PromptSection.text` provider may not await.
 *
 * Degradation is deterministic: no judgment service, an unavailable judge,
 * or a failed call all fall back to the conservative secondary-key rule
 * instead of breaking the assembly. `meta.probability` gates candidacy by a
 * stable hash before any judge sees an entry, `meta.position` picks the block
 * an entry lands in, and `meta.depth` gives a tail entry its attachment
 * window, clamped to the messages the session actually holds.
 *
 * @module omd-tavern-assemble
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AssembledSection } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import type { TavernDocument } from 'omd-context-tavern/document'
import { normalizeProject, TavernStore } from 'omd-context-tavern/store'
import { renderAuthorNote, renderLorebook } from './assemble.ts'
import { decideEntries, type Decision } from './decide.ts'
import { resolveGroups, selectEntries, type SelectOutput } from './select.ts'

/** Plugin name for registration in Cordis. */
export const name = 'omd-tavern-assemble'

/** Services required before this plugin's fiber activates. */
export const inject = ['systemPrompt']

/** Name of the lorebook prefix section. */
const LOREBOOK_SECTION = 'omd-tavern-assemble:lorebook'

/** Name of the lorebook section placed after the character definitions. */
const LOREBOOK_AFTER_SECTION = 'omd-tavern-assemble:lorebook-after'

/** Name of the lorebook section placed at the tail of the system prompt. */
const LOREBOOK_DEPTH_SECTION = 'omd-tavern-assemble:lorebook-depth'

/** Name of the Author's Note section. */
const AUTHOR_NOTE_SECTION = 'omd-tavern-assemble:author-note'

/** Where the plugin's four sections sit, resolved against registry anchors. */
export interface SectionPlacement {
  readonly lorebook: number
  readonly lorebookAfter: number
  readonly authorNote: number
  readonly lorebookDepth: number
}

/**
 * Resolve the four section orders. The prefix sits just before the plan policy
 * (as it always has); the position-1 block follows the deployment persona, so
 * it reads as "after the character definitions"; the Author's Note follows it,
 * and the position-4 block is last, one slot past the note.
 * @param planPolicy - `getSectionOrder('PLAN_POLICY')`.
 * @param personaSuffix - `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')`.
 */
export function sectionPlacement(planPolicy: number, personaSuffix: number): SectionPlacement {
  return {
    lorebook: planPolicy - 1,
    lorebookAfter: personaSuffix + 1,
    authorNote: personaSuffix + 2,
    lorebookDepth: personaSuffix + 3,
  }
}

/** Deployment settings. */
export interface Config {
  /** Mount the assembler at all. Off leaves the profile untouched. */
  enabled: boolean
  /** How many recent user messages count as the turn material for key matching. */
  recentUserMessages: number
  /** Judge include-answers below this confidence are treated as exclude. */
  confidenceFloor: number
  /** Estimated token ceiling for the whole lorebook section. */
  maxPrefixTokens: number
  /** Estimated token ceiling for one entry body. */
  singleEntryMaxTokens: number
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true)
    .description('Mount the tavern assembler and inject the project document into model requests.'),
  recentUserMessages: z.natural().min(1).default(4)
    .description('How many recent user messages form the material that primary keys match against.'),
  confidenceFloor: z.number().min(0).max(1).default(0.4)
    .description('Judge include answers below this confidence are treated as exclude.'),
  maxPrefixTokens: z.natural().min(1).default(8000)
    .description('Estimated token ceiling for the whole lorebook section; entries beyond it are skipped.'),
  singleEntryMaxTokens: z.natural().min(1).default(1500)
    .description('Estimated token ceiling for one entry body; a longer entry is clipped in place.'),
})

/** Convert an unknown value into a one-line diagnostic. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Concatenated text blocks of one message, or `''`. */
function textOf(messageData: { readonly content?: readonly unknown[] }): string {
  if (!Array.isArray(messageData.content)) return ''
  const parts: string[] = []
  for (const block of messageData.content) {
    if (typeof block !== 'object' || block === null || !('type' in block) || !('text' in block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * The turn material: the last `limit` user messages on the session log,
 * oldest first. Genuine user input counts first; if a session has none
 * (a driven or forked session), any user-role message fills the window.
 * @param session - the live session.
 * @param limit - window size from Config.
 */
function recentUserTexts(session: Session, limit: number): string[] {
  const all: Array<{ text: string; fromUser: boolean }> = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const text = textOf(event.data)
    if (text === '') continue
    all.push({ text, fromUser: event.data.source.kind === 'user' })
  }
  const chosen = all.filter(item => item.fromUser).slice(-limit)
  const picked = chosen.length > 0 ? chosen : all.slice(-limit)
  return picked.map(item => item.text)
}

/** Messages currently in the session, the ceiling a tail entry's depth clamps to. */
function conversationMessageCount(session: Session): number {
  let count = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message' || event.type === 'assistant/message') count += 1
  }
  return count
}

/**
 * Compute this turn's sections for one agent, or `[]` when there is nothing to
 * inject (no cwd, empty document, everything gated or budgeted away).
 * @param ctx - plugin context, for the judgment service and the audit log.
 * @param config - validated plugin configuration.
 * @param store - the per-project document reader.
 * @param agent - the agent being assembled for.
 * @param signal - the assembly's abort signal, passed to the judge.
 */
async function buildSections(
  ctx: Context,
  config: Config,
  store: TavernStore,
  agent: Agent,
  signal: AbortSignal | undefined,
): Promise<AssembledSection[]> {
  const cwd = agent.session?.header?.cwd
  if (cwd === undefined || cwd === '') return []
  let document: TavernDocument
  try {
    document = await store.load(normalizeProject(cwd))
  } catch (error) {
    ctx.logger.warn(`omd-tavern-assemble: cannot load document for ${cwd}: ${message(error)}`)
    return []
  }
  if (document.lorebook.length === 0 && document.authorNote.trim() === '') return []

  const texts = recentUserTexts(agent.session, config.recentUserMessages)
  const material = texts.join('\n')
  const selection: SelectOutput = selectEntries({
    entries: document.lorebook,
    material,
    frozenEntryIds: document.frozenEntryIds,
    judgeAvailable: ctx.get('judgment') !== undefined,
  })
  for (const item of selection.skipped) {
    ctx.logger.info(`omd-tavern-assemble: 「${item.entry.name}」probability ${item.gate.probability} 未命中落点 ${item.gate.roll.toFixed(2)}，跳过`)
  }

  const judgment = ctx.get('judgment')
  const decisions: ReadonlyMap<string, Decision> = await decideEntries({
    judged: selection.judged.map(item => item.entry),
    material,
    judge: judgment ?? undefined,
    confidenceFloor: config.confidenceFloor,
    signal,
  })
  for (const item of selection.judged) {
    const decision = decisions.get(item.entry.id)
    if (decision === undefined) continue
    if (decision.source === 'judge') {
      ctx.logger.info(`omd-tavern-assemble: 判官「${item.entry.name}」→ ${decision.choice}（置信度 ${decision.confidence.toFixed(2)}）`)
    } else if (decision.source === 'low-confidence') {
      ctx.logger.warn(`omd-tavern-assemble: 判官「${item.entry.name}」include 置信度 ${decision.confidence.toFixed(2)} 低于下限 ${config.confidenceFloor}，按 exclude 处理`)
    } else if (decision.source === 'invalid-answer') {
      ctx.logger.warn(`omd-tavern-assemble: 判官对「${item.entry.name}」的答案无法解析，按 exclude 处理`)
    } else if (decision.source === 'judge-fallback') {
      ctx.logger.warn(`omd-tavern-assemble: 判官调用失败，「${item.entry.name}」按保守规则处理`)
    } else {
      ctx.logger.info(`omd-tavern-assemble: 判官不可用，「${item.entry.name}」按保守规则 → ${decision.choice}`)
    }
  }

  const included = new Map<string, boolean>()
  for (const item of selection.judged) {
    included.set(item.entry.id, decisions.get(item.entry.id)?.choice === 'include')
  }
  const winners = resolveGroups(selection.judged, included)
  const chosenIds = new Set([...selection.direct.map(item => item.entry), ...winners].map(entry => entry.id))
  const chosen = document.lorebook.filter(entry => chosenIds.has(entry.id))

  const lorebook = renderLorebook({ entries: chosen, budgets: config, messageCount: conversationMessageCount(agent.session) })
  for (const warning of lorebook.warnings) ctx.logger.warn(`omd-tavern-assemble: ${warning}`)
  const authorNote = renderAuthorNote(document.authorNote)
  const sections: AssembledSection[] = []
  if (lorebook.prefix !== '') sections.push({ name: LOREBOOK_SECTION, text: lorebook.prefix, interpolate: false })
  if (lorebook.after !== '') sections.push({ name: LOREBOOK_AFTER_SECTION, text: lorebook.after, interpolate: false })
  if (authorNote.text !== '') sections.push({ name: AUTHOR_NOTE_SECTION, text: authorNote.text, interpolate: false })
  if (lorebook.tail !== '') sections.push({ name: LOREBOOK_DEPTH_SECTION, text: lorebook.tail, interpolate: false })
  return sections
}

/**
 * Register the four prompt sections and the per-agent waterfall that fills
 * them. Sections with empty text contribute nothing, so a session without a
 * cwd or with an empty document sees no change.
 * @param ctx - Host context with `systemPrompt`.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const store = new TavernStore()
  const placement = sectionPlacement(
    ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
  )
  ctx.systemPrompt.section({
    name: LOREBOOK_SECTION,
    order: placement.lorebook,
    interpolate: false,
    text: '',
  })
  ctx.systemPrompt.section({
    name: LOREBOOK_AFTER_SECTION,
    order: placement.lorebookAfter,
    interpolate: false,
    text: '',
  })
  ctx.systemPrompt.section({
    name: AUTHOR_NOTE_SECTION,
    order: placement.authorNote,
    interpolate: false,
    text: '',
  })
  ctx.systemPrompt.section({
    name: LOREBOOK_DEPTH_SECTION,
    order: placement.lorebookDepth,
    interpolate: false,
    text: '',
  })
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next()
      const target = context.agent ?? agent
      try {
        const sections = await buildSections(ctx, config, store, target, context.signal)
        if (sections.length === 0) return result
        return {
          ...result,
          sections: [...result.sections, ...sections],
        }
      } catch (error) {
        ctx.logger.warn(`omd-tavern-assemble: assembly skipped: ${message(error)}`)
        return result
      }
    })
  })
}
