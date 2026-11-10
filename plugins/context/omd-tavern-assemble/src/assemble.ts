/**
 * Text assembly: turn the selected entries into the lorebook blocks and the
 * Author's Note this plugin contributes.
 *
 * `meta.position` decides which block an entry lands in. Position 0 (before the
 * character definitions) goes to the prefix block at its usual place near the
 * front of the prompt; position 1 (after the character definitions) goes to a
 * second block registered after the deployment persona; position 4 (at depth)
 * goes to a trailing block registered last, because the registry can only
 * place text inside the system prompt, never between conversation messages.
 * That tail block is the honest approximation of "N messages before the end":
 * its entries carry `meta.depth` (default 4) as their attachment window, and
 * the window is clamped to the messages the session actually has.
 *
 * Within a block, entries render as `## 名称` headings ordered by `meta.order`
 * (entries without one keep their document position, sorted with the
 * SillyTavern default order 100). Two token budgets apply across all blocks,
 * both estimated with the same estimator the budget uses: a single entry body
 * over `singleEntryMaxTokens` is clipped in place, and once the running total
 * passes `maxPrefixTokens` the remaining entries are skipped. Every cut is
 * reported as a warning string so the caller can log it.
 *
 * @module omd-tavern-assemble/assemble
 */

import type { LoreEntry } from 'omd-context-tavern/document'
import { estimateTokens } from 'omd-judge-context'

/** Token budgets, straight from the plugin Config. */
export interface RenderBudgets {
  /** Total ceiling for the whole lorebook section. */
  readonly maxPrefixTokens: number
  /** Ceiling for one entry body. */
  readonly singleEntryMaxTokens: number
}

/** One rendered section plus the warnings the caller should log. */
export interface RenderedSection {
  /** The section text; `''` when nothing renders and the caller drops it. */
  readonly text: string
  /** One line per truncation or skip, already human-readable. */
  readonly warnings: readonly string[]
}

/** The three placements `meta.position` can ask for. */
export type LoreSection = 'prefix' | 'after' | 'tail'

/** Everything one turn's lorebook rendering needs. */
export interface RenderInput {
  /** Selected entries, in document order. */
  readonly entries: readonly LoreEntry[]
  /** The two token ceilings from Config, shared across all three blocks. */
  readonly budgets: RenderBudgets
  /** Messages currently in the session; a tail entry's depth clamps to it. */
  readonly messageCount: number
}

/** The three rendered blocks plus the warnings for the whole render. */
export interface LorebookSections {
  /** Tagged prefix block; `''` when no entry landed there. */
  readonly prefix: string
  /** Tagged block registered after the character definitions; `''` when empty. */
  readonly after: string
  /** Tagged block registered at the tail; `''` when empty. */
  readonly tail: string
  /** One line per depth clamp, truncation or budget skip, logged once. */
  readonly warnings: readonly string[]
}

/** SillyTavern's default for a position-4 entry that names no depth. */
export const DEFAULT_DEPTH = 4

/** A position-4 entry's attachment window after clamping. */
export interface DepthResolution {
  /** `meta.depth`, or {@link DEFAULT_DEPTH}; negative values read as 0. */
  readonly requested: number
  /** The window that survives clamping to the available messages. */
  readonly effective: number
  /** Messages the session actually holds. */
  readonly available: number
  /** Whether the available history was shorter than the request. */
  readonly clamped: boolean
}

/** The V2 card spec writes positions as names; World Info writes numbers. */
const POSITION_ALIASES: Readonly<Record<string, number>> = { before_char: 0, after_char: 1 }

/** Sort key of an entry: its `meta.order`, or the SillyTavern default 100. */
function orderOf(entry: LoreEntry): number {
  return entry.meta?.order ?? 100
}

/** `meta.position` as a number, defaulting to 0 for absent or unknown values. */
function positionOf(entry: LoreEntry): number {
  const raw = entry.meta?.position
  if (raw === undefined) return 0
  if (typeof raw === 'number') return raw
  const alias = POSITION_ALIASES[raw]
  if (alias !== undefined) return alias
  const numeric = Number(raw)
  return Number.isFinite(numeric) ? numeric : 0
}

/**
 * Which block the entry belongs in. Positions 2 and 3 (top and bottom of the
 * Author's Note) have no insertion point here: the note is one section, not a
 * pair, so those entries fall back to the prefix rather than pretending.
 * @param entry - the entry to place.
 */
export function loreSectionOf(entry: LoreEntry): LoreSection {
  const position = positionOf(entry)
  if (position === 1) return 'after'
  if (position === 4) return 'tail'
  return 'prefix'
}

/**
 * Resolve a position-4 entry's attachment window against the real history.
 * @param entry - the entry carrying `meta.depth`.
 * @param messageCount - messages currently in the session.
 */
export function resolveDepth(entry: LoreEntry, messageCount: number): DepthResolution {
  const requested = Math.max(0, Math.floor(entry.meta?.depth ?? DEFAULT_DEPTH))
  const available = Math.max(0, messageCount)
  const effective = Math.min(requested, available)
  return { requested, effective, available, clamped: effective < requested }
}

/** Shortest prefix of the content, in code points, within the token budget. */
function clipToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const points = Array.from(text)
  let low = 0
  let high = points.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(points.slice(0, mid).join('')) <= maxTokens) low = mid
    else high = mid - 1
  }
  return `${points.slice(0, low).join('')}…`
}

/** One block's tag and the entries waiting to render into it. */
interface BlockPlan {
  readonly tag: string
  readonly entries: LoreEntry[]
}

/**
 * Render the three lorebook blocks from the entries selected for this turn.
 * The token budget is shared: blocks are filled in prompt order (prefix, after,
 * tail), so a full prefix leaves nothing for the blocks behind it.
 * @param input - entries, budgets and the current message count.
 * @returns one section per placement, each `''` when nothing survived.
 */
export function renderLorebook(input: RenderInput): LorebookSections {
  const warnings: string[] = []
  const plans: Record<LoreSection, BlockPlan> = {
    prefix: { tag: 'tavern-lorebook', entries: [] },
    after: { tag: 'tavern-lorebook-after', entries: [] },
    tail: { tag: 'tavern-lorebook-depth', entries: [] },
  }
  for (const entry of input.entries) plans[loreSectionOf(entry)].entries.push(entry)
  const depths = new Map<string, DepthResolution>()
  for (const entry of plans.tail.entries) {
    const depth = resolveDepth(entry, input.messageCount)
    depths.set(entry.id, depth)
    if (depth.clamped) {
      warnings.push(`条目「${entry.name}」的 depth ${depth.requested} 超过可用历史 ${depth.available} 条消息，已收敛为 ${depth.effective}`)
    }
  }
  const blocks: Record<LoreSection, string[]> = { prefix: [], after: [], tail: [] }
  let total = 0
  let skipped = 0
  for (const section of ['prefix', 'after', 'tail'] as const) {
    const ordered = plans[section].entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => orderOf(a.entry) - orderOf(b.entry) || a.index - b.index)
    for (const { entry } of ordered) {
      const content = entry.content.trim()
      if (content === '') continue
      let body = content
      if (estimateTokens(body) > input.budgets.singleEntryMaxTokens) {
        body = clipToTokens(body, input.budgets.singleEntryMaxTokens)
        warnings.push(`条目「${entry.name}」正文超过 ${input.budgets.singleEntryMaxTokens} token，已截断`)
      }
      const block = `## ${entry.name}\n\n${body}`
      const cost = estimateTokens(block)
      if (total + cost > input.budgets.maxPrefixTokens) {
        skipped += 1
        continue
      }
      blocks[section].push(block)
      total += cost
    }
  }
  if (skipped > 0) {
    warnings.push(`已有 ${skipped} 个条目因总量超过 ${input.budgets.maxPrefixTokens} token 被跳过`)
  }
  const depthNote = [...new Set([...depths.values()].map(depth => depth.effective))]
    .sort((a, b) => a - b)
    .join('、')
  const rendered: Record<LoreSection, string> = {
    prefix: '',
    after: '',
    tail: '',
  }
  for (const section of ['prefix', 'after', 'tail'] as const) {
    if (blocks[section].length === 0) continue
    const header = section === 'tail'
      ? `以下设定附着于对话尾部，注入深度分别按最近 ${depthNote} 条消息计。`
      : null
    rendered[section] = [
      `<${plans[section].tag}>`,
      ...(header === null ? [] : [header]),
      ...blocks[section],
      `</${plans[section].tag}>`,
    ].join('\n\n')
  }
  return { ...rendered, warnings }
}

/**
 * Render the Author's Note section. The note is verbatim — it is a Markdown
 * field the human edits, and the assembler adds only its tag.
 * @param note - the document's `authorNote`.
 * @returns the tagged block, or `''` when the note is blank.
 */
export function renderAuthorNote(note: string): RenderedSection {
  const body = note.trim()
  if (body === '') return { text: '', warnings: [] }
  return { text: `<tavern-author-note>\n${body}\n</tavern-author-note>`, warnings: [] }
}
