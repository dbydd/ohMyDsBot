/**
 * The durable shape of a retain job and its validation.
 *
 * A job is what the store keeps and what one delivery sends: everything the
 * server needs is here, so a delivery never consults live configuration. That
 * is what makes a queued job survive a restart with a different profile patch
 * and still mean what it meant when it was written.
 *
 * `sessionId`, `turn` and `throughSeq` are the watermark carrier: the newest
 * job of one session tells a restart which turn the session already retained.
 *
 * @module omd-memory/queue/job
 */

import { randomUUID } from 'node:crypto'

/** How a job writes over an existing document. */
export type JobUpdateMode = 'append' | 'replace'

/** One queued retain. */
export interface RetainJob {
  /** Job identity; doubles as the server's operation id for an async retain. */
  id: string
  /** Session that produced it. */
  sessionId: string
  /** Turn that produced it. */
  turn: number
  /** Highest session seq the projection had folded into this job. */
  throughSeq: number
  /** Target bank. */
  bankId: string
  /** Document this job appends to or replaces. */
  documentId: string
  /** Write semantics. */
  updateMode: JobUpdateMode
  /** When the job was enqueued. */
  createdAt: string
  /** The payload one delivery sends. */
  item: RetainItem
  /** Delivery attempts so far. */
  retries: number
  /** Redacted text of the last failure. */
  lastError?: string
  /** Set when the job was moved to the dead-letter file. */
  deadLetteredAt?: string
}

/** What one delivery sends. */
export interface RetainItem {
  /** Serialized turn content. */
  content: string
  /** Free-form context naming the turn. */
  context: string
  /** When the content happened. */
  timestamp?: string
  /** Ask the server to extract in the background. */
  async?: boolean
  /** Memory tags: the project tag and the scope tags travel here. */
  tags?: string[]
  /** Document tags, separate from memory tags. */
  documentTags?: string[]
  /** Extra per-memory metadata. */
  metadata?: Record<string, string>
  /** Observation scoping for the extraction pass. */
  observationScopes?: 'per_tag' | 'combined' | 'all_combinations' | 'shared' | string[][]
  /** Named extraction strategy. */
  strategy?: string
}

/**
 * Whether a parsed value is a complete job. A record missing any required
 * field is quarantined rather than delivered half-formed.
 * @param value - a parsed JSON value.
 * @returns true for a usable job.
 */
export function isRetainJob(value: unknown): value is RetainJob {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const item = record.item as Record<string, unknown> | undefined
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.turn === 'number'
    && typeof record.throughSeq === 'number'
    && typeof record.bankId === 'string'
    && typeof record.documentId === 'string'
    && (record.updateMode === 'append' || record.updateMode === 'replace')
    && typeof record.createdAt === 'string'
    && typeof record.retries === 'number'
    && item !== undefined
    && item !== null
    && typeof item === 'object'
    && typeof item.content === 'string'
    && typeof item.context === 'string'
}

/**
 * Build a fresh job.
 * @param fields - everything but the identity and the attempt counter.
 * @returns the job, ready to append.
 */
export function newRetainJob(fields: Omit<RetainJob, 'id' | 'retries' | 'createdAt'>): RetainJob {
  return { id: randomUUID(), createdAt: new Date().toISOString(), retries: 0, ...fields }
}
