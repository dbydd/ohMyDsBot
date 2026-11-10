/**
 * The one session record a notebook revision leaves behind.
 *
 * This is the only module that calls `appendPluginRecord`: the writer is an
 * experimental Session API, and a record written with a bare type name makes
 * every reader refuse the whole log. The `plugin:` name plus the `ignorable`
 * marker is what lets an older harness retain the record and skip it.
 *
 * @module omd-context-notes/record
 */

import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

/** The record type this package owns. */
export const NOTE_RECORD_TYPE = 'plugin:omd-context-notes/updated'

/** Who wrote the revision. */
export type NoteAuthor = 'user' | 'agent' | 'task'

/** Which part of the notebook the write replaced. */
export type NoteSection = 'shared' | 'agent' | 'full'

/** One committed revision. */
export interface NoteRecordPayload {
  /** Whole notebook text after the write. */
  text: string
  /** UTF-8 byte length of {@link text}. */
  bytes: number
  /** Monotonic revision stamp; the projection keeps the newest. */
  version: number
  /** Who wrote it. */
  author: NoteAuthor
  /** Which section the write replaced. */
  section: NoteSection
}

/**
 * Append one revision as an ignorable plugin record.
 * @param session - the session whose notebook changed.
 * @param payload - the whole notebook after the write.
 * @returns the committed record's sequence number, when the session reports one.
 */
export function appendNoteRecord(session: Session, payload: NoteRecordPayload): unknown {
  return appendPluginRecord(session, NOTE_RECORD_TYPE, { ...payload })
}
