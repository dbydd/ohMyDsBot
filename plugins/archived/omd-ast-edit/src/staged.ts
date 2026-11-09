/**
 * Pure staging and commit logic for `omd-ast-edit`.
 *
 * `ast_edit` records sites; `ast_apply` re-derives them from the live tree and
 * decides whether the record is still truthful. Everything here is free of I/O
 * so the two guarantees the host relies on — a byte-identical worktree after
 * staging, and partial application after a hand edit — follow from the
 * comparison alone.
 *
 * Byte offsets come from ast-grep and index the file as it sits on disk, so the
 * splice runs on raw UTF-8 bytes and decodes only once, at the end. This is
 * exact because `ctx.fs.readText` returns the file byte-for-byte and `writeText`
 * writes the given text verbatim (`fs-local`: no line-ending normalization on
 * that path), so a CRLF file comes back as it went in. A backend that normalized
 * on read would shift every offset after the first `\r`, which is why the splice
 * re-reads through the same seam the write uses rather than caching content.
 *
 * @module omd-ast-edit/staged
 */

import type { AstSite } from './engine.ts'

/**
 * One staged rewrite: the query that produced it, the root it searched from,
 * and every site it found. `ast_apply` re-runs the query, so the query is the
 * contract and `sites` is the expectation it checks against.
 */
export interface StagedEdit {
  readonly pattern: string
  readonly replacement: string
  readonly glob: string
  readonly root: string
  readonly sites: readonly AstSite[]
}

/** Verdict on a staged record against the sites the live tree still matches. */
export type SiteComparison =
  | { readonly kind: 'identical' }
  | { readonly kind: 'stale'; readonly missing: number }
  | { readonly kind: 'extra'; readonly delta: number }

/** Outcome of splicing one file's sites. */
export interface SpliceOutcome {
  readonly text: string
  readonly applied: number
  readonly skipped: number
  readonly added: number
  readonly removed: number
}

/**
 * Count how many times each site's identity appears, so `compareSites` can tell
 * "the same site found again" from "a new, identical one".
 * @param sites - the sites to count.
 * @returns identity to occurrence count.
 */
export function siteMultiset(sites: readonly AstSite[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const site of sites) {
    const key = `${site.file}\u0000${site.text}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * Compare a staged record against the sites the live tree matches now.
 *
 * A site is *missing* when the tree holds fewer copies of it than were staged —
 * a hand edit that deleted or rewrote it — and *new* when the tree holds more,
 * a pattern occurrence added since. Staleness wins over novelty, because a
 * record that has lost a site is not merely larger, it is wrong.
 * @param staged - the sites `ast_edit` recorded.
 * @param fresh - the sites `ast_apply` re-found.
 * @returns the verdict.
 */
export function compareSites(staged: readonly AstSite[], fresh: readonly AstSite[]): SiteComparison {
  const stagedCounts = siteMultiset(staged)
  const freshCounts = siteMultiset(fresh)
  let missing = 0
  let extra = 0
  for (const [key, count] of stagedCounts) {
    const seen = freshCounts.get(key) ?? 0
    if (seen < count) missing += count - seen
  }
  for (const [key, count] of freshCounts) {
    const known = stagedCounts.get(key) ?? 0
    if (count > known) extra += count - known
  }
  if (missing > 0) return { kind: 'stale', missing }
  if (extra > 0) return { kind: 'extra', delta: extra }
  return { kind: 'identical' }
}

/**
 * Splice the sites into one file's content in a single forward pass.
 *
 * A site is skipped rather than applied when its byte range falls outside the
 * file, when the file no longer holds the text it staged for, or when the range
 * overlaps an already-accepted site — ast-grep reports non-overlapping matches,
 * so each of these means the file moved under the rewrite, and leaving that one
 * alone is the safe action.
 * @param source - the file's current content, byte-for-byte as read for this splice.
 * @param sites - the live sites for this file.
 * @returns the spliced content, the accepted count, the skipped count, and the
 *   line delta the accepted sites produced.
 */
export function spliceSites(source: string, sites: readonly AstSite[]): SpliceOutcome {
  const bytes = Buffer.from(source, 'utf8')
  const ordered = [...sites].sort((a, b) => a.byteStart - b.byteStart || a.byteEnd - b.byteEnd)

  const parts: Buffer[] = []
  const accepted: AstSite[] = []
  let skipped = 0
  let cursor = 0
  for (const site of ordered) {
    const length = site.byteEnd - site.byteStart
    const inBounds = site.byteStart >= 0 && length > 0 && site.byteEnd <= bytes.length
    if (site.byteStart < cursor || !inBounds) {
      skipped += 1
      continue
    }
    if (bytes.subarray(site.byteStart, site.byteEnd).toString('utf8') !== site.text) {
      skipped += 1
      continue
    }
    parts.push(bytes.subarray(cursor, site.byteStart), Buffer.from(site.replacement, 'utf8'))
    accepted.push(site)
    cursor = site.byteEnd
  }

  parts.push(bytes.subarray(cursor))

  let added = 0
  let removed = 0
  for (const site of accepted) {
    const delta = lineDelta(site.text, site.replacement)
    added += delta.added
    removed += delta.removed
  }

  return {
    text: Buffer.concat(parts).toString('utf8'),
    applied: accepted.length,
    skipped,
    added,
    removed,
  }
}

/**
 * Line delta of one site: lines whose text appears only on one side.
 * @param before - the matched text.
 * @param after - the replacement text.
 * @returns lines added and lines removed.
 */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  return { added: unmatched(after, before), removed: unmatched(before, after) }
}

/**
 * Count the lines in `source` that `against` has no counterpart for, by text.
 * @param source - the side whose surplus is counted.
 * @param against - the side that can absorb a line.
 * @returns the surplus line count.
 */
function unmatched(source: string, against: string): number {
  const outstanding = new Map<string, number>()
  for (const line of against.split('\n')) outstanding.set(line, (outstanding.get(line) ?? 0) + 1)
  let surplus = 0
  for (const line of source.split('\n')) {
    const count = outstanding.get(line) ?? 0
    if (count > 0) outstanding.set(line, count - 1)
    else surplus += 1
  }
  return surplus
}
