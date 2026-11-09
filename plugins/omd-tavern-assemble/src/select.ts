/**
 * Deterministic pre-selection: which lorebook entries are even eligible for
 * injection this turn, before any judge call.
 *
 * `constant === true` entries are frozen candidates — the host half already
 * owns the epoch machinery that rebuilds the frozen prefix, so this module
 * treats them as always-in. Everything else first has to win on primary keys:
 * any `keys` entry appearing in the turn material (the recent user-message
 * text) makes the entry a candidate. An entry with no keys and no
 * `meta.selective` never enters. Candidates that carry `secondaryKeys` with
 * `meta.selective` are held back for the judge (or, without one, resolved by
 * the conservative rule `conservativeSecondary` documents).
 *
 * Every candidate then passes the probability gate, before any judge sees it:
 * a hash of the entry id and the turn material picks a stable point in
 * `[0, 100)`, and `meta.probability` is the share of that range that admits the
 * entry. The gate runs ahead of the judge queue so no answer can bring back an
 * entry the gate excluded.
 *
 * @module omd-tavern-assemble/select
 */

import type { LoreEntry } from 'omd-context-tavern/document'

/** SillyTavern secondary-key semantics: 0 AND_ANY · 1 NOT_ALL · 2 NOT_ANY · 3 AND_ALL. */
export type SelectiveLogic = 0 | 1 | 2 | 3

/** Everything the selector needs to know about one turn. */
export interface SelectInput {
  /** The whole lorebook, in document order. */
  readonly entries: readonly LoreEntry[]
  /** The material primary keys match against: recent user-message text. */
  readonly material: string
  /** Entries currently frozen into the prefix; their ids go through verbatim. */
  readonly frozenEntryIds: readonly string[]
  /** Whether the judge is available for secondary-key adjudication. */
  readonly judgeAvailable: boolean
}

/** One entry the selector decided about. */
export interface SelectedEntry {
  readonly entry: LoreEntry
  /** How the entry earned its place. */
  readonly via: 'constant' | 'primary-key'
  /** True when secondary keys still need the judge (or fell back conservatively). */
  readonly pendingSecondary: boolean
}

/** The probability gate's verdict for one candidate. */
export interface ProbabilityGate {
  /** The entry's `meta.probability`, clamped to `[0, 100]`; 100 when absent. */
  readonly probability: number
  /** The stable point in `[0, 100)` the entry drew this turn. */
  readonly roll: number
  /** Whether `roll` fell under `probability`. */
  readonly include: boolean
}

/** One entry the gate dropped, with the verdict that dropped it. */
export interface SkippedEntry {
  readonly entry: LoreEntry
  readonly gate: ProbabilityGate
}

/** The selector's whole output: what to inject now and what the judge must answer. */
export interface SelectOutput {
  /** Entries to place in the prefix this turn, without waiting for the judge. */
  readonly direct: SelectedEntry[]
  /** Entries whose secondary-key condition the judge decides. */
  readonly judged: SelectedEntry[]
  /** Candidates the probability gate threw out. */
  readonly skipped: SkippedEntry[]
}

/** FNV-1a over the UTF-16 code units; the same string always lands on the same number. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * The deterministic stand-in for SillyTavern's chance roll. The point is drawn
 * from the entry id and the turn material, both of which change only when the
 * conversation does, so an entry stays in or out for as long as the same
 * recent messages are in view — same input, same verdict, no randomness.
 * @param entry - the candidate carrying `meta.probability`.
 * @param material - the turn material the keys matched against.
 */
export function probabilityGate(entry: LoreEntry, material: string): ProbabilityGate {
  const probability = Math.min(100, Math.max(0, entry.meta?.probability ?? 100))
  const roll = (fnv1a(`${entry.id}\u0000${material}`) % 10000) / 100
  return { probability, roll, include: probability >= 100 || (probability > 0 && roll < probability) }
}

/**
 * Whether an entry's secondary keys pass under the conservative rule that
 * replaces the judge when none is available: logics 2 (NOT_ANY) and 3 (AND_ALL)
 * require a secondary key itself to appear in the material, logics 0 (AND_ANY)
 * and 1 (NOT_ALL) pass on the primary hit alone.
 * @param entry - the candidate with `meta.selective`.
 * @param material - the same turn material the primary keys matched.
 */
export function conservativeSecondary(entry: LoreEntry, material: string): boolean {
  const logic = entry.meta?.selectiveLogic
  if (logic !== 2 && logic !== 3) return true
  const secondary = entry.meta?.secondaryKeys ?? []
  if (logic === 2) return !secondary.some(key => key !== '' && material.includes(key))
  return secondary.every(key => key !== '' && material.includes(key))
}

/**
 * Run the deterministic pre-selection. Pure: no logging, no judge, no state.
 * Grouping is not resolved here — same-group candidates travel to the judge
 * together (the state names the group), so the judge sees the mutual
 * exclusion rather than the selector silently picking one.
 * @param input - entries, material, frozen ids, judge availability.
 * @returns direct entries plus entries held for the judge.
 */
export function selectEntries(input: SelectInput): SelectOutput {
  const frozen = new Set(input.frozenEntryIds)
  const direct: SelectedEntry[] = []
  const judged: SelectedEntry[] = []
  const skipped: SkippedEntry[] = []
  const place = (entry: LoreEntry, via: SelectedEntry['via'], pendingSecondary: boolean): void => {
    const gate = probabilityGate(entry, input.material)
    if (!gate.include) {
      skipped.push({ entry, gate })
      return
    }
    const selected = { entry, via, pendingSecondary }
    if (pendingSecondary) judged.push(selected)
    else direct.push(selected)
  }
  for (const entry of input.entries) {
    if (entry.constant === true || frozen.has(entry.id)) {
      place(entry, 'constant', false)
      continue
    }
    const primaryHit = entry.keys.some(key => key !== '' && input.material.includes(key))
    const wantsSecondary = entry.meta?.selective === true && (entry.meta?.secondaryKeys?.length ?? 0) > 0
    if (!primaryHit) {
      if (entry.keys.length === 0 && wantsSecondary && input.judgeAvailable) {
        // A keyless selective entry has no primary hit to stand on: only the
        // judge can admit it, on the secondary keys and the logic alone.
        place(entry, 'primary-key', true)
      }
      continue
    }
    // Selective candidates always travel through the judge queue, judge or
    // not: decideEntries falls back to the conservative rule, and routing
    // them here keeps group resolution and audit logging uniform.
    place(entry, 'primary-key', wantsSecondary)
  }
  return { direct, judged, skipped }
}

/**
 * Apply the judge's per-entry choices to one group of candidates, dropping
 * same-group losers. The judge answers per entry; within a `meta.group` only
 * the highest `meta.order` among the *included* entries survives.
 * @param selected - the candidates the judge was asked about.
 * @param included - per-entry-id boolean from the judge (or the conservative rule).
 * @returns the entries that enter the prefix this turn.
 */
export function resolveGroups(selected: readonly SelectedEntry[], included: ReadonlyMap<string, boolean>): LoreEntry[] {
  const admitted = selected
    .filter(item => included.get(item.entry.id) === true)
    .map(item => item.entry)
  const groups = new Map<string, LoreEntry>()
  const winners: LoreEntry[] = []
  for (const entry of admitted) {
    const group = entry.meta?.group
    if (group === undefined || group === '') {
      winners.push(entry)
      continue
    }
    const current = groups.get(group)
    if (current === undefined) {
      groups.set(group, entry)
      continue
    }
    const challengerOrder = entry.meta?.order ?? -1
    const currentOrder = current.meta?.order ?? -1
    if (challengerOrder > currentOrder) groups.set(group, entry)
  }
  for (const entry of groups.values()) winners.push(entry)
  return winners
}
