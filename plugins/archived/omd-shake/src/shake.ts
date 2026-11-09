/**
 * The rewrite engine behind `/shake`.
 *
 * dsh's surface contract allows a new surface event to replace one contiguous
 * run of current surface nodes, provided it cites every node it shadows
 * (`packages/core/session/src/types.ts:446-465`). Two node types can carry such
 * a replacement here:
 *
 * - `tool/result` — the one type whose replacement may change `content` alone;
 *   every other field must stay identical (`surface.ts:456-485`).
 * - `user/message` — replaceable by another user message over exactly itself,
 *   which is how an older prompt's image blocks come out.
 *
 * `assistant/message` cannot be a replacement at all: it embeds its provider
 * stream and may not carry `sourceEventSeqs` (`surface.ts:335-337`), so the one
 * node type holding reasoning is the one type no rewrite can shadow. That is
 * why `thinking` measures instead of removing.
 *
 * @module omd-shake/shake
 */

import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-session'
import {
  ELIDED_PREFIX,
  ELIDED_TEXT,
  IMAGE_ELIDED_TEXT,
  SPILL_LOCATION,
  type ShakeMode,
  type ShakeReport,
} from './types.ts'

/**
 * Read one current surface event.
 *
 * `Session.eventAt` is deprecated repo-wide (`packages/core/session/src/index.ts:706`)
 * because a future store may page history. It remains the only synchronous
 * reader that returns a node's payload, and the in-tree tool-result pruner reads
 * the same way under the same waiver
 * (`packages/compaction/compaction-tool-result-pruner/src/index.ts:139-142`).
 * A rewrite needs each node's exact event to rebuild it with every field outside
 * `content` untouched; no projection exposes that payload.
 * @param session - session whose current surface is being read.
 * @param seq - surface node sequence number.
 * @returns the committed event at that sequence, or undefined.
 */
function surfaceEvent(session: Session, seq: SessionSeq): SessionEvent | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- See this function's JSDoc.
  return session.eventAt(seq)
}

/**
 * The nodes one run may touch: everything before the last `recentKeep` entries.
 * @param seqs - candidate nodes in model-visible order.
 * @param recentKeep - count of trailing entries to leave untouched.
 * @returns the eligible prefix.
 */
function olderThan(seqs: readonly SessionSeq[], recentKeep: number): readonly SessionSeq[] {
  return seqs.slice(0, Math.max(0, seqs.length - recentKeep))
}

/** Concatenated text of a content list; non-text blocks contribute nothing. */
function textOf(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) if (block.type === 'text') text += block.text
  return text
}

/** Whether a result already carries this package's elision marker. */
function isElided(content: readonly ContentBlock[]): boolean {
  const only = content.length === 1 ? content[0] : undefined
  return only !== undefined && only.type === 'text' && only.text.startsWith(ELIDED_PREFIX)
}

/**
 * The recovery address a spill notice publishes, when the text ends in one.
 *
 * `dsh-spill-local` saves the full text to a file and appends
 * `(...Full formatted result stored at: <path>. <hint>)`
 * (`packages/spill/spill-policy/src/notice.ts:5-24`). Keeping the locator and
 * its hint inside the marker is what makes an elided result recoverable without
 * an artifact store: the model can still read or grep that path.
 * @param text - a result's complete recorded text.
 * @returns the notice's locator and retrieval hint, or undefined when the text
 *   carries no notice.
 */
function spillReference(text: string): string | undefined {
  if (!text.endsWith(')')) return undefined
  const marker = text.lastIndexOf(SPILL_LOCATION)
  if (marker < 0) return undefined
  // The notice owns its segment: it either opens the result or follows the
  // preview separator. Anything else is prose quoting the notice spelling.
  if (!text.startsWith('(') && text.lastIndexOf('\n\n(', marker) < 0) return undefined
  const reference = text.slice(marker + SPILL_LOCATION.length, text.length - 1).trim()
  return reference.length === 0 ? undefined : reference
}

/**
 * The marker that stands in for one elided result.
 * @param originalText - the result's text before elision.
 * @returns the marker, carrying a recovery address when the result had one.
 */
function elisionMarker(originalText: string): string {
  const reference = spillReference(originalText)
  return reference === undefined ? ELIDED_TEXT : `(elided: see ${reference})`
}

/**
 * Replace the model-facing content of every tool result older than the
 * retained window.
 * @param session - session whose current surface is rewritten.
 * @param recentKeep - trailing tool results left untouched.
 * @returns counts, byte totals, and the shadowed surface seqs.
 */
function elideToolResults(session: Session, recentKeep: number): ShakeReport {
  const toolSeqs = [...session.surface.nodes].filter(seq => surfaceEvent(session, seq)?.type === 'tool/result')
  const shadowed: number[] = []
  let bytesBefore = 0
  let bytesAfter = 0
  for (const seq of olderThan(toolSeqs, recentKeep)) {
    const event = surfaceEvent(session, seq)
    if (event === undefined || event.type !== 'tool/result') continue
    const original = session.deriveEventMessage(event)
    if (original === null || original.role !== 'tool') continue
    if (isElided(original.content)) continue
    const before = textOf(original.content)
    const marker = elisionMarker(before)
    for (const block of original.content) {
      // An offloaded image already reached the model as placeholder text.
      if (block.type === 'image' && block.offloaded !== true) bytesBefore += block.attachment.bytes
    }
    const message = freezeMessage<ToolResultMessage>({
      ...original,
      content: [{ type: 'text', text: marker }],
    })
    session.append('tool/result', { ...event.data, message }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    shadowed.push(seq)
    bytesBefore += Buffer.byteLength(before, 'utf8')
    bytesAfter += Buffer.byteLength(marker, 'utf8')
  }
  return {
    mode: 'elide',
    toolResultsElided: shadowed.length,
    imagesRemoved: 0,
    thinkingBlocksFound: 0,
    thinkingMessages: 0,
    bytesBefore,
    bytesAfter,
    shadowedSeqs: shadowed,
  }
}

/**
 * Remove image blocks from every message older than the retained window.
 *
 * A message whose blocks were all images keeps one text placeholder, because an
 * empty user or tool message carries no meaning and providers reject empty
 * content. Images already marked offloaded count as removed but not as saved
 * bytes: their request cost was already placeholder text.
 * @param session - session whose current surface is rewritten.
 * @param recentKeep - trailing surface messages left untouched.
 * @returns counts, byte totals, and the shadowed surface seqs.
 */
function removeImages(session: Session, recentKeep: number): ShakeReport {
  const shadowed: number[] = []
  let imagesRemoved = 0
  let bytesBefore = 0
  let bytesAfter = 0
  for (const seq of olderThan([...session.surface.nodes], recentKeep)) {
    const event = surfaceEvent(session, seq)
    if (event === undefined) continue
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    const kept: ContentBlock[] = []
    let images = 0
    for (const block of message.content) {
      if (block.type !== 'image') {
        kept.push(block)
        continue
      }
      images += 1
      if (block.offloaded !== true) bytesBefore += block.attachment.bytes
    }
    if (images === 0) continue
    // Only the placeholder is new; the retained blocks were already paid for.
    if (kept.length === 0) {
      kept.push({ type: 'text', text: IMAGE_ELIDED_TEXT })
      bytesAfter += Buffer.byteLength(IMAGE_ELIDED_TEXT, 'utf8')
    }
    const surfaceOp = { op: 'replace', startSeq: seq, endSeq: seq } as const
    if (event.type === 'user/message' && message.role === 'user') {
      session.append(
        'user/message',
        freezeMessage<UserMessage>({ ...message, content: kept }),
        { surfaceOp, sourceEventSeqs: [seq] },
      )
    } else if (event.type === 'tool/result' && message.role === 'tool') {
      const replacement = freezeMessage<ToolResultMessage>({ ...message, content: kept })
      session.append('tool/result', { ...event.data, message: replacement }, { surfaceOp, sourceEventSeqs: [seq] })
    } else {
      continue
    }
    imagesRemoved += images
    shadowed.push(seq)
  }
  return {
    mode: 'images',
    toolResultsElided: 0,
    imagesRemoved,
    thinkingBlocksFound: 0,
    thinkingMessages: 0,
    bytesBefore,
    bytesAfter,
    shadowedSeqs: shadowed,
  }
}

/**
 * Measure the reasoning blocks older messages still carry.
 *
 * Nothing is rewritten: see this module's header for why the node type that
 * holds reasoning cannot be replaced.
 * @param session - session being measured.
 * @param recentKeep - trailing surface messages left out of the measurement.
 * @returns reasoning block and message counts plus their UTF-8 byte total.
 */
function measureThinking(session: Session, recentKeep: number): ShakeReport {
  let blocks = 0
  let messages = 0
  let bytes = 0
  for (const seq of olderThan([...session.surface.nodes], recentKeep)) {
    const event = surfaceEvent(session, seq)
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    let found = 0
    for (const block of message.content) {
      if (block.type !== 'reasoning') continue
      found += 1
      bytes += Buffer.byteLength(block.text, 'utf8')
    }
    if (found === 0) continue
    blocks += found
    messages += 1
  }
  return {
    mode: 'thinking',
    toolResultsElided: 0,
    imagesRemoved: 0,
    thinkingBlocksFound: blocks,
    thinkingMessages: messages,
    bytesBefore: bytes,
    // Nothing was removed, so the same bytes still stand.
    bytesAfter: bytes,
    shadowedSeqs: [],
  }
}

/**
 * Run one shake strategy against a session's current surface.
 *
 * Each replacement is one event shadowing exactly the node it rewrites, citing
 * that node, so replay recovers the original content and a later
 * `/shake` skips what an earlier run already elided.
 * @param session - the session to rewrite or measure.
 * @param mode - strategy to apply.
 * @param recentKeep - entries at the tail the run must leave untouched.
 * @returns counts, byte totals, and the shadowed surface seqs.
 */
export function shakeSession(session: Session, mode: ShakeMode, recentKeep: number): ShakeReport {
  switch (mode) {
    case 'elide':
      return elideToolResults(session, recentKeep)
    case 'images':
      return removeImages(session, recentKeep)
    case 'thinking':
      return measureThinking(session, recentKeep)
  }
}
