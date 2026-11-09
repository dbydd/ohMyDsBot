/**
 * The one-line summary `/shake` returns, sharing omp's wording where the
 * strategies line up.
 *
 * The no-op lines are fixed strings: a strategy that finds nothing is a
 * successful no-op, not an error, so a caller can distinguish "nothing left to
 * shake" from "the command failed" without parsing prose.
 *
 * @module omd-shake/report
 */

import {
  NO_IMAGES_FOUND,
  NO_THINKING_FOUND,
  NOTHING_TO_SHAKE,
  type ShakeReport,
} from './types.ts'

/**
 * Render a byte count at operator-readable scale.
 * @param bytes - non-negative byte count.
 * @returns the count in B, KB, or MB.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Render one count with its noun.
 * @param count - non-negative count.
 * @param noun - singular spelling of the counted thing.
 * @returns the number and the correctly inflected noun.
 */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Summarize one shake run for the command result.
 * @param report - what the run changed.
 * @returns the fixed no-op line, or the counts and bytes the run moved.
 */
export function formatShakeReport(report: ShakeReport): string {
  const freed = formatBytes(Math.max(0, report.bytesBefore - report.bytesAfter))
  switch (report.mode) {
    case 'elide':
      if (report.toolResultsElided === 0) return NOTHING_TO_SHAKE
      return `Elided ${plural(report.toolResultsElided, 'tool result')}: `
        + `${formatBytes(report.bytesBefore)} -> ${formatBytes(report.bytesAfter)} (${freed} freed).`
    case 'images':
      if (report.imagesRemoved === 0) return NO_IMAGES_FOUND
      return `Removed ${plural(report.imagesRemoved, 'image')}: ${freed} freed.`
    case 'thinking':
      if (report.thinkingBlocksFound === 0) return NO_THINKING_FOUND
      return `Found ${plural(report.thinkingBlocksFound, 'thinking block')} `
        + `(${formatBytes(report.bytesBefore)}) in ${plural(report.thinkingMessages, 'older message')}; nothing removed. `
        + 'This harness cannot rewrite an assistant message in place, so `/compact` remains the way to fold them into a summary.'
  }
}
