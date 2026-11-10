/**
 * The one authoritative shape of a Bot's project-level context configuration:
 * lorebook catalog, frozen prefix, epoch archive, Author's Note and story
 * notes. One JSON file per project directory holds it; the browser panel and
 * the `tavern://` internal paths both go through the same store.
 *
 * @module omd-context-tavern/document
 */

import { z } from 'zod'

/** The document version this host reads and writes. */
export const DOCUMENT_VERSION = 1

/**
 * SillyTavern fields an import rescues but the plugin does not interpret yet.
 * There is no assembler, so nothing here has behaviour: the values are stored
 * exactly as the card carried them and shown read-only in the editor, waiting
 * for a decision (judge) to give them meaning.
 *
 * Every field is optional, so a document written before this shape existed
 * still validates; unknown keys pass through, so a newer export never makes
 * the whole project unreadable.
 */
export const loreMetaSchema = z
  .object({
    /** `keysecondary` / `secondary_keys`: SillyTavern's second trigger list. */
    secondaryKeys: z.array(z.string()).optional(),
    /** Whether the second key list takes part in triggering. */
    selective: z.boolean().optional(),
    /** 0 AND_ANY · 1 NOT_ALL · 2 NOT_ANY · 3 AND_ALL */
    selectiveLogic: z.number().optional(),
    caseSensitive: z.boolean().nullable().optional(),
    matchWholeWords: z.boolean().nullable().optional(),
    order: z.number().optional(),
    group: z.string().optional(),
    groupWeight: z.number().optional(),
    useGroupScoring: z.boolean().nullable().optional(),
    sticky: z.number().optional(),
    cooldown: z.number().optional(),
    delay: z.number().optional(),
    probability: z.number().optional(),
    depth: z.number().optional(),
    /** World Info writes a number, the V2 card spec a string like `before_char`. */
    position: z.union([z.number(), z.string()]).optional(),
    /** World Info writes 0/1/2, the V2 card spec a string like `assistant`. */
    role: z.union([z.number(), z.string()]).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
    /** Where the entry came from; written once at import. */
    source: z
      .object({
        format: z.enum(['character-card', 'world-info']),
        version: z.string().optional(),
        file: z.string().optional(),
      })
      .optional(),
  })
  .catchall(z.unknown())

/** One lorebook entry: its trigger keys, frozen-prefix flag, and injected body. */
export const loreEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  keys: z.array(z.string()),
  constant: z.boolean(),
  content: z.string(),
  meta: loreMetaSchema.optional(),
})

/** One archived epoch of the frozen prefix. */
export const epochRecordSchema = z.object({
  id: z.string().min(1),
  at: z.number(),
  archivedAt: z.number(),
  tokens: z.number(),
  entries: z.array(z.string()),
})

/** The whole project document, including the optimistic-concurrency revision. */
export const documentSchema = z.object({
  version: z.literal(DOCUMENT_VERSION),
  revision: z.number().int().nonnegative(),
  project: z.string().min(1),
  epochId: z.string().min(1),
  epochStartedAt: z.number(),
  lorebook: z.array(loreEntrySchema),
  frozenEntryIds: z.array(z.string()),
  epochs: z.array(epochRecordSchema),
  authorNote: z.string(),
  storyNotes: z.string(),
})

export type LoreEntry = z.infer<typeof loreEntrySchema>
export type EpochRecord = z.infer<typeof epochRecordSchema>
export type TavernDocument = z.infer<typeof documentSchema>

/** The document a project that has never been written reads. */
export function defaultDocument(project: string, now: number = Date.now()): TavernDocument {
  return {
    version: DOCUMENT_VERSION,
    revision: 0,
    project,
    epochId: 'E-01',
    epochStartedAt: now,
    lorebook: [],
    frozenEntryIds: [],
    epochs: [],
    authorNote: '',
    storyNotes: '',
  }
}

/**
 * Validate a document recovered from disk or received from the browser.
 * A malformed document is an error, never a silent reset: resetting would
 * discard the user's state without telling anyone.
 *
 * @param raw - the parsed JSON value.
 * @returns the validated document.
 * @throws when the shape is not a version-1 tavern document.
 */
export function parseDocument(raw: unknown): TavernDocument {
  const result = documentSchema.safeParse(raw)
  if (result.success) return result.data
  const details = result.error.issues
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  throw new Error(`not a tavern project document: ${details}`)
}
