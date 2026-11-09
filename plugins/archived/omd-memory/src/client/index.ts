/**
 * The Hindsight HTTP client: the subset of the server's surface the memory
 * backend uses, bounded by one timeout, with polled reads retried.
 *
 * What this module does NOT do: it never picks a bank, never decides whether
 * a turn should recall, and never reads host configuration. It is a transport
 * with typed results; policy lives in the caller.
 *
 * Wrapped calls are only the ones this package issues — recall, retain, bank
 * profiles and stats, mental models, and health. Everything the SDK offers
 * beyond that (knowledge pages, directives, imports, file retain) is
 * control-panel work, not a turn's work, and is deliberately absent.
 *
 * @module omd-memory/client
 */

import {
  HindsightClient,
  HindsightError,
  createClient,
  createConfig,
  sdk,
} from '@vectorize-io/hindsight-client'
import type {
  BankProfileResponse,
  Client,
  MentalModelListResponse,
  RecallResponse,
  ReflectResponse,
  RetainResponse,
  TagGroupLeaf,
} from '@vectorize-io/hindsight-client'
import { redactError } from '../sanitize.ts'
import { installFetchRequestCompat } from './fetch-compat.ts'
import { statusOf, withRetry } from './retry.ts'
import { withTimeout } from './timeout.ts'

/** User agent every request carries, so a server log names this client. */
export const USER_AGENT = 'omd-memory/0.1.0'

/** Options of one retain call. */
export interface RetainOptions {
  /** Existing document to extend or replace. */
  documentId?: string
  /** Document-level tags, separate from memory tags. */
  documentTags?: string[]
  /** Memory tags; the project tag and scope tags travel here. */
  tags?: string[]
  /** Free-form context shown to the extractor. */
  context?: string
  /** When the content happened; defaults to now on the server. */
  timestamp?: string
  /** Extra per-memory metadata. */
  metadata?: Record<string, string>
  /** Ask the server to extract in the background. */
  async?: boolean
  /** Caller-supplied id making an async retry idempotent. */
  operationId?: string
  /** `append` extends an existing document; `replace` overwrites it. */
  updateMode?: 'append' | 'replace'
  /** Observation scoping for the extraction pass. */
  observationScopes?: 'per_tag' | 'combined' | 'all_combinations' | 'shared' | string[][]
  /** Named extraction strategy. */
  strategy?: string
}

/** Options of one recall call. */
export interface RecallOptions {
  /** Fact types to include. */
  types?: string[]
  /** Drop raw facts a returned observation already covers. */
  preferObservations?: boolean
  /** Token budget of the call. */
  maxTokens?: number
  /** Server-side effort. */
  budget?: 'low' | 'mid' | 'high'
  /** Flat tag filter. */
  tags?: string[]
  /** How the flat tag filter matches. */
  tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact'
  /** Compound tag filter; mutually exclusive with `tags`. */
  tagGroups?: TagGroupLeaf[]
  /** Include observations that carry no tag at all. */
  includeSharedObservations?: boolean
  /** Per-stage score floors. */
  minScores?: { semantic?: number, keyword?: number, reranker?: number, final?: number }
  /** Cancellation from the caller. */
  signal?: AbortSignal
}

/** Outcome of one retain delivery, normalized across the server's response shapes. */
export interface RetainOutcome {
  /** Ids of background operations the server accepted. */
  operationIds: string[]
  /** Number of memories the server extracted synchronously, when reported. */
  itemsCount?: number
  /** Tokens the server billed, when reported. */
  tokens?: number
}

/** Health of one configured endpoint. */
export interface HealthResult {
  ok: boolean
  /** Redacted failure text; absent when `ok`. */
  error?: string
}

/** The memory server as this package uses it. */
export interface HindsightClientLike {
  /** Bank profile, including its mission and configuration. */
  getBankProfile(bankId: string): Promise<BankProfileResponse>
  /** Counts and other server-side statistics for one bank. */
  getBankStats(bankId: string): Promise<unknown>
  /** Create a bank or update the fields given on an existing one. */
  createBank(bankId: string, options: CreateBankOptions): Promise<BankProfileResponse>
  /** Create or update the mission and extraction settings of a bank. */
  updateBankConfig(bankId: string, options: CreateBankOptions): Promise<unknown>
  /** List the bank's mental models. */
  listMentalModels(bankId: string, options?: { detail?: 'metadata' | 'content' | 'full', limit?: number }): Promise<MentalModelListResponse>
  /** Recall memories for one query. */
  recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResponse>
  /** Reflect on the bank's memories and answer one query. */
  reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResponse>
  /** Retain one memory. */
  retain(bankId: string, content: string, options?: RetainOptions): Promise<RetainResponse>
  /** Server version and feature flags, used as a cheap reachability probe. */
  health(): Promise<unknown>
}

/** Fields `ensureBank` may set; all are optional so an existing bank keeps the rest. */
export interface CreateBankOptions {
  reflectMission?: string
  retainMission?: string
  retainExtractionMode?: string
  enableObservations?: boolean
}

/** Options of one reflect call. */
export interface ReflectOptions {
  context?: string
  budget?: 'low' | 'mid' | 'high'
  maxTokens?: number
  tags?: string[]
  tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact'
  tagGroups?: TagGroupLeaf[]
  factTypes?: string[]
  excludeMentalModels?: boolean
  signal?: AbortSignal
}

/** Connection facts one client is built from. */
export interface ClientSettings {
  /** Base URL of the memory server. */
  baseUrl: string
  /** Resolved API key; absent means the server needs none. */
  apiKey?: string
  /** Deadline for one call. */
  timeoutMs: number
}

/**
 * Turn one SDK response envelope into its value, or throw with the server's
 * own detail attached.
 * @param response - the SDK envelope.
 * @param operation - label used in the thrown message.
 * @returns the envelope's data.
 */
function unwrap<T>(response: { data?: T, error?: unknown, response?: Response }, operation: string): T {
  if (response.data !== undefined) return response.data
  const error = response.error as { detail?: unknown, message?: string } | undefined
  const details = error?.detail ?? error?.message ?? error
  throw new HindsightError(`${operation} failed: ${JSON.stringify(details)}`, response.response?.status, details)
}

/**
 * Build a client over one endpoint.
 * @param settings - resolved connection facts.
 * @returns the client; every call is bounded by `settings.timeoutMs`.
 */
export function createHindsightClient(settings: ClientSettings): HindsightClientLike {
  installFetchRequestCompat()

  const baseUrl = settings.baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
  if (settings.apiKey !== undefined && settings.apiKey !== '') headers.Authorization = `Bearer ${settings.apiKey}`

  const raw = new HindsightClient({
    baseUrl,
    ...(settings.apiKey !== undefined && settings.apiKey !== '' ? { apiKey: settings.apiKey } : {}),
    userAgent: USER_AGENT,
  })
  const lowLevel: Client = createClient(createConfig({ baseUrl, headers }))
  const timeoutMs = settings.timeoutMs

  return {
    getBankProfile: (bankId) => withTimeout('hindsight getBankProfile', timeoutMs, () =>
      withRetry('getBankProfile', () => raw.getBankProfile(bankId, {}))),
    getBankStats: (bankId) => withTimeout('hindsight getBankStats', timeoutMs, () => withRetry('getBankStats', async () => {
      const response = await sdk.getAgentStats({ client: lowLevel, path: { bank_id: bankId } })
      return unwrap(response, 'getBankStats')
    })),
    createBank: (bankId, options) =>
      withTimeout('hindsight createBank', timeoutMs, () => raw.createBank(bankId, options)),
    updateBankConfig: (bankId, options) =>
      withTimeout('hindsight updateBankConfig', timeoutMs, () => raw.updateBankConfig(bankId, {
        ...(options.reflectMission !== undefined ? { reflectMission: options.reflectMission } : {}),
        ...(options.retainMission !== undefined ? { retainMission: options.retainMission } : {}),
        ...(options.retainExtractionMode !== undefined ? { retainExtractionMode: options.retainExtractionMode } : {}),
        ...(options.enableObservations !== undefined ? { enableObservations: options.enableObservations } : {}),
      })),
    listMentalModels: (bankId, options) => withTimeout('hindsight listMentalModels', timeoutMs, () =>
      withRetry('listMentalModels', () => raw.listMentalModels(bankId, {
        detail: options?.detail ?? 'content',
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      }))),
    recall: (bankId, query, options) => withTimeout(
      'hindsight recall',
      timeoutMs,
      (signal) => raw.recall(bankId, query, {
        ...(options?.types !== undefined ? { types: options.types } : {}),
        ...(options?.preferObservations !== undefined ? { preferObservations: options.preferObservations } : {}),
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.budget !== undefined ? { budget: options.budget } : {}),
        ...(options?.minScores !== undefined ? { minScores: options.minScores } : {}),
        ...(options?.includeSharedObservations ? { tagsMatch: 'any' as const } : {}),
        ...(options?.tagGroups !== undefined ? { tagGroups: options.tagGroups } : {}),
        ...(options?.tagGroups === undefined && options?.tags !== undefined ? { tags: options.tags } : {}),
        ...(options?.tagGroups === undefined && options?.tagsMatch !== undefined ? { tagsMatch: options.tagsMatch } : {}),
        signal,
      }),
      options?.signal,
    ),
    reflect: (bankId, query, options) => withTimeout(
      'hindsight reflect',
      timeoutMs,
      (signal) => raw.reflect(bankId, query, {
        ...(options?.context !== undefined ? { context: options.context } : {}),
        ...(options?.budget !== undefined ? { budget: options.budget } : {}),
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.tags !== undefined ? { tags: options.tags } : {}),
        ...(options?.tagsMatch !== undefined ? { tagsMatch: options.tagsMatch } : {}),
        ...(options?.tagGroups !== undefined ? { tagGroups: options.tagGroups } : {}),
        ...(options?.factTypes !== undefined ? { factTypes: options.factTypes as Array<'world' | 'experience' | 'observation'> } : {}),
        ...(options?.excludeMentalModels !== undefined ? { excludeMentalModels: options.excludeMentalModels } : {}),
        signal,
      }),
      options?.signal,
    ),
    retain: (bankId, content, options) => withTimeout(
      'hindsight retain',
      timeoutMs,
      (signal) => options?.documentTags?.length
        ? raw.retainBatch(bankId, [{
          content,
          ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
          ...(options.context !== undefined ? { context: options.context } : {}),
          ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
          ...(options.documentId !== undefined ? { document_id: options.documentId } : {}),
          ...(options.tags !== undefined ? { tags: options.tags } : {}),
          ...(options.observationScopes !== undefined ? { observation_scopes: options.observationScopes } : {}),
          ...(options.updateMode !== undefined ? { update_mode: options.updateMode } : {}),
          ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
        }], {
          ...(options.async !== undefined ? { async: options.async } : {}),
          ...(options.async === true && options.operationId !== undefined ? { operationId: options.operationId } : {}),
          documentTags: options.documentTags,
          signal,
        })
        : raw.retain(bankId, content, {
          ...(options?.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
          ...(options?.context !== undefined ? { context: options.context } : {}),
          ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
          ...(options?.documentId !== undefined ? { documentId: options.documentId } : {}),
          ...(options?.async !== undefined ? { async: options.async } : {}),
          ...(options?.async === true && options?.operationId !== undefined ? { operationId: options.operationId } : {}),
          ...(options?.tags !== undefined ? { tags: options.tags } : {}),
          ...(options?.observationScopes !== undefined ? { observationScopes: options.observationScopes } : {}),
          ...(options?.updateMode !== undefined ? { updateMode: options.updateMode } : {}),
          ...(options?.strategy !== undefined ? { strategy: options.strategy } : {}),
          signal,
        }),
    ),
    health: () => withTimeout('hindsight health', timeoutMs, () => withRetry('health', async () => {
      const response = await sdk.healthEndpointHealthGet({ client: lowLevel })
      return unwrap(response, 'health')
    })),
  }
}

/**
 * Normalize a retain response into the outcome the queue records.
 * @param response - the server's retain response.
 * @returns operation ids and the counts the server reported.
 */
export function parseRetainOutcome(response: unknown): RetainOutcome {
  const operationIds: string[] = []
  let itemsCount: number | undefined
  let tokens: number | undefined
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>
    const usage = record.usage && typeof record.usage === 'object'
      ? record.usage as Record<string, unknown>
      : undefined
    for (const candidate of [record.operation_id, record.operationId, record.id]) {
      if (typeof candidate === 'string' && candidate !== '') operationIds.push(candidate)
    }
    for (const item of Array.isArray(record.operations) ? record.operations : []) {
      if (typeof item === 'string') operationIds.push(item)
      else if (item && typeof item === 'object') {
        const id = (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).operation_id
        if (typeof id === 'string') operationIds.push(id)
      }
    }
    const count = record.items_count ?? record.itemsCount
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) itemsCount = count
    const total = usage?.total_tokens
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) tokens = total
  }
  return {
    operationIds: [...new Set(operationIds)],
    ...(itemsCount !== undefined ? { itemsCount } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  }
}

/**
 * Probe one endpoint. The answer is a fact ("it answered", "it did not"), never
 * a thrown error: a caller decides what an unreachable server means.
 * @param client - client to probe.
 * @returns health plus the redacted failure text.
 */
export async function checkHealth(client: HindsightClientLike): Promise<HealthResult> {
  try {
    await client.health()
    return { ok: true }
  } catch (error) {
    // A retired profile still proves the server answered; only transport and
    // 5xx failures mean "unreachable".
    const status = statusOf(error)
    if (status === 404 || status === 410) return { ok: true }
    return { ok: false, error: redactError(error) }
  }
}
