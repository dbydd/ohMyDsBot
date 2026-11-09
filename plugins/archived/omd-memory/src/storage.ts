/**
 * The memory plugin's own durable state.
 *
 * Why a domain and not a file: schema validation at open, one write chain, and
 * `domain/changed` events come for free, and the medium stays the backend's
 * choice rather than ours. Why not the session log: a plugin may not append its
 * own records (`appendPluginRecord` is reserved for the harness's experimental
 * packages), so anything that must outlive a turn and cannot be re-derived from
 * the log belongs here.
 *
 * @module omd-memory/storage
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

/** Stored watermark: the highest session seq already retained. */
const watermarkSchema = z.object({
  throughSeq: z.number().int().min(0),
  turn: z.number().int().min(0),
  updatedAt: z.string().min(1),
}).strict()

/** What one retained session looks like on the medium. */
export type WatermarkRecord = z.infer<typeof watermarkSchema>

/**
 * The `omd_memory` domain: watermarks keyed by session id.
 *
 * The table is keyed by the session id, which stays stable across a resume, so
 * a resumed session picks up its own watermark rather than starting over.
 */
export const memoryDomain = defineDomain({
  name: 'omd_memory',
  version: 1,
  tables: {
    watermarks: domainTable<string, WatermarkRecord>(watermarkSchema),
  },
})

/** The opened memory domain, typed by its spec. */
export type MemoryDomain = Domain<typeof memoryDomain>
