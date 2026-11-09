/**
 * The bank layer: project-bank derivation, the idempotent bank ensure, and
 * every memory operation a session needs — recall across BOTH banks, retain
 * routed by scope, reflect, directives, mental models.
 *
 * Bank model (the mnemopi routing omp's hindsight deployment grew out of):
 * one shared {@link ResolvedConfig.globalBank} plus one bank per project.
 * Writes land in the scope the caller names; recalls merge the project bank
 * (full budget) with the global bank (a smaller budget) and dedupe by id.
 *
 * @module omd-hindsight/banks
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import type { ResolvedConfig } from './config.ts'
import { HindsightError, request } from './client.ts'

/** One recalled memory, as the server returns it. */
export interface RecallHit {
  /** The server id; the curation handle. */
  id: string
  /** The memory text. */
  text: string
  /** The memory type (`world`, `experience`, `observation`, …), when given. */
  type?: string
  /** Which bank the hit came from; absent on raw server hits. */
  bank?: 'project' | 'global'
}

/** One standing directive (rule), priority-ordered by the server. */
export interface DirectiveRule {
  /** The server id. */
  id: string
  /** The rule's name. */
  name: string
  /** The rule's text. */
  content: string
  /** Sort weight; higher binds tighter. */
  priority: number
}

/** One persisted mental model (a named, refreshed summary). */
export interface MentalModel {
  /** The server id. */
  id: string
  /** The model's display name. */
  name: string
  /** The model's current rendered content. */
  content: string
}

/** Which bank a write or a reflect targets. */
export type Scope = 'project' | 'global'

/** Hard lifetime for a detached prefetch job's HTTP work. */
export const PREFETCH_TTL_MS = 120_000

/**
 * Derive the project bank id for one working directory: an explicit
 * {@link ResolvedConfig.projectBankMap} entry wins (absolute path first,
 * then the lowercased directory name), else
 * `<prefix>-<slug>-<sha256-12-base36>`.
 * @param cwd - the session's working directory.
 * @param config - resolved plugin configuration.
 * @returns the bank id.
 */
export function projectBankFor(cwd: string, config: ResolvedConfig): string {
  const absolute = path.resolve(cwd)
  const slug = (path.basename(absolute).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'default')
  const mapped = config.projectBankMap[absolute] ?? config.projectBankMap[slug]
  if (mapped !== undefined && mapped.length > 0) return mapped
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 16)
  return limit(`${config.projectBankPrefix}-${slug}-${BigInt(`0x${hash}`).toString(36)}`)
}

/** Clamp a bank id to the server's 63-char limit, keeping the hash tail. */
function limit(bank: string): string {
  if (bank.length <= 63) return bank
  const tail = bank.slice(bank.lastIndexOf('-') + 1)
  return `${bank.slice(0, 62 - tail.length)}-${tail}`
}

/**
 * Build the bank operations for one plugin instance.
 * @param config - resolved plugin configuration.
 * @returns the operations; every method tolerates a stopped server by
 * throwing {@link HindsightError} for the caller to swallow.
 */
export function createBanks(config: ResolvedConfig) {
  /** Project bank ids per working directory, memoized. */
  const projectBanks = new Map<string, string>()
  /** Banks this process has already ensured. */
  const ensured = new Set<string>()
  /** In-flight ensures, so one bank's PUT runs once even under concurrent recalls. */
  const ensuring = new Map<string, Promise<void>>()

  /**
   * The project bank for one session cwd, memoized.
   * @param cwd - the session's working directory.
   */
  function bankFor(cwd: string): { project: string; retain: string } {
    let project = projectBanks.get(cwd)
    if (project === undefined) {
      project = projectBankFor(cwd, config)
      projectBanks.set(cwd, project)
    }
    return { project, retain: config.scoping === 'global' ? config.globalBank : project }
  }

  /**
   * Idempotently create a bank with its mission. Runs once per bank per
   * process, before the first memory operation; failures leave the bank
   * unensured so the next operation retries. Never throws.
   * @param bank - the bank id.
   * @param mission - the mission text to install.
   * @param signal - the calling operation's signal.
   */
  function ensure(bank: string, mission: string, signal: AbortSignal): Promise<void> {
    if (ensured.has(bank)) return Promise.resolve()
    const pending = ensuring.get(bank)
    if (pending !== undefined) return pending
    const attempt = request(config, `/banks/${encodeURIComponent(bank)}`, { mission, background: mission }, signal, 'PUT')
      .then(() => { ensured.add(bank) })
      .catch(() => { /* the next operation retries */ })
      .finally(() => { ensuring.delete(bank) })
    ensuring.set(bank, attempt)
    return attempt
  }

  /**
   * One bank's recall. The whole bank is visible (no tier filter): the
   * two-bank split IS the partition.
   */
  async function recallOne(bank: string, query: string, maxTokens: number, signal: AbortSignal): Promise<RecallHit[]> {
    const data = await request(config, `/banks/${encodeURIComponent(bank)}/memories/recall`, {
      query,
      max_tokens: maxTokens,
      types: ['world', 'experience', 'observation'],
      prefer_observations: true,
    }, signal)
    const results = data.results
    if (!Array.isArray(results)) return []
    return results.filter((hit): hit is RecallHit =>
      typeof hit === 'object' && hit !== null
      && typeof (hit as RecallHit).id === 'string'
      && typeof (hit as RecallHit).text === 'string',
    )
  }

  /**
   * Recall BOTH banks: the project bank at the full budget, the global bank
   * at {@link ResolvedConfig.recallGlobalBudget}, in parallel; project hits
   * win id collisions. Both legs failing throws; one failing yields the
   * other's hits.
   * @param cwd - the session's working directory.
   * @param query - the composed recall query.
   * @param signal - the caller's budget.
   * @returns merged hits, project bank first.
   */
  async function recall(cwd: string, query: string, signal: AbortSignal): Promise<RecallHit[]> {
    const { project } = bankFor(cwd)
    await ensure(project, config.projectMission, signal)
    await ensure(config.globalBank, config.globalMission, signal)
    const settled = await Promise.allSettled([
      recallOne(project, query, config.maxRecallTokens, signal),
      recallOne(config.globalBank, query, config.recallGlobalBudget, signal),
    ])
    // Both legs are independent: either may be down without failing the turn.
    // Only a doubly-dead server throws, so the caller's budget ends the attempt.
    const [projectLeg, globalLeg] = settled
    if (projectLeg.status === 'rejected' && globalLeg.status === 'rejected') throw globalLeg.reason
    const projectHits = projectLeg.status === 'fulfilled' ? projectLeg.value : []
    const globalHits = globalLeg.status === 'fulfilled' ? globalLeg.value : []
    const seen = new Set(projectHits.map(hit => hit.id))
    const merged: RecallHit[] = projectHits.map(hit => ({ ...hit, bank: 'project' }))
    for (const hit of globalHits) {
      if (seen.has(hit.id)) continue
      seen.add(hit.id)
      merged.push({ ...hit, bank: 'global' })
    }
    return merged
  }

  /**
   * Recall ONE bank explicitly, for a tool call that names its scope.
   * @param cwd - the session's working directory.
   * @param query - the recall query.
   * @param scope - which bank to query.
   * @param maxTokens - the token budget for this lookup.
   * @param signal - cancellation.
   * @returns the bank's hits.
   */
  async function recallScoped(cwd: string, query: string, scope: Scope, maxTokens: number, signal: AbortSignal): Promise<RecallHit[]> {
    const { project } = bankFor(cwd)
    const bank = scope === 'global' ? config.globalBank : project
    await ensure(bank, bank === config.globalBank ? config.globalMission : config.projectMission, signal)
    const hits = await recallOne(bank, query, maxTokens, signal)
    return hits.map(hit => ({ ...hit, bank: scope }))
  }

  /**
   * List the active standing directives of BOTH banks, priority-ordered.
   * Directives reach the model every turn even when recall matches nothing,
   * so their availability is load-bearing; a bank that fails to answer
   * yields no rules rather than failing the pair.
   */
  async function directives(cwd: string, signal: AbortSignal): Promise<DirectiveRule[]> {
    const { project } = bankFor(cwd)
    const banks = project === config.globalBank ? [project] : [project, config.globalBank]
    const settled = await Promise.allSettled(banks.map(async bank => {
      await ensure(bank, bank === config.globalBank ? config.globalMission : config.projectMission, signal)
      const data = await request(config, `/banks/${encodeURIComponent(bank)}/directives?active_only=true`, {}, signal, 'GET')
      const items = data.items
      if (!Array.isArray(items)) return []
      return items.filter((rule): rule is DirectiveRule =>
        typeof rule === 'object' && rule !== null
        && typeof (rule as DirectiveRule).id === 'string'
        && typeof (rule as DirectiveRule).name === 'string'
        && typeof (rule as DirectiveRule).content === 'string'
        && typeof (rule as DirectiveRule).priority === 'number',
      )
    }))
    const merged = new Map<string, DirectiveRule>()
    for (const leg of settled) {
      if (leg.status !== 'fulfilled') continue
      for (const rule of leg.value) if (!merged.has(rule.id)) merged.set(rule.id, rule)
    }
    return [...merged.values()].sort((a, b) => b.priority - a.priority)
  }

  /**
   * Store one memory into the scope's bank. Waits for the bank's fact
   * extraction unless {@link ResolvedConfig.retainAsync} is set.
   * @param cwd - the session's working directory (picks the project bank).
   * @param content - the memory text.
   * @param scope - which bank receives it.
   * @param timestamp - optional ISO-8601 occurrence time.
   * @param signal - cancellation.
   */
  async function retain(cwd: string, content: string, scope: Scope, timestamp: string | undefined, signal: AbortSignal): Promise<void> {
    const { retain: bank } = bankFor(cwd)
    const target = scope === 'global' ? config.globalBank : bank
    await ensure(target, target === config.globalBank ? config.globalMission : config.projectMission, signal)
    const item: Record<string, unknown> = { content }
    if (timestamp !== undefined && timestamp.length > 0) item.timestamp = timestamp
    const body: Record<string, unknown> = { items: [item] }
    if (config.retainAsync) body.async = true
    await request(config, `/banks/${encodeURIComponent(target)}/memories`, body, signal)
  }

  /**
   * Reflect on one bank: the server's curated natural-language answer over
   * the bank's memory graph.
   */
  async function reflect(cwd: string, query: string, scope: Scope, signal: AbortSignal): Promise<string> {
    const { retain: bank } = bankFor(cwd)
    const target = scope === 'global' ? config.globalBank : bank
    await ensure(target, target === config.globalBank ? config.globalMission : config.projectMission, signal)
    const data = await request(config, `/banks/${encodeURIComponent(target)}/reflect`, { query }, signal)
    return typeof data.text === 'string' && data.text.length > 0 ? data.text : 'the bank returned an empty answer'
  }

  /**
   * One bank's mental models with content, for the prompt section.
   * @returns sorted by name; empty when the bank has none or fails.
   */
  async function mentalModels(cwd: string, signal: AbortSignal): Promise<MentalModel[]> {
    const { project } = bankFor(cwd)
    await ensure(project, config.projectMission, signal)
    const data = await request(config, `/banks/${encodeURIComponent(project)}/mental-models?detail=content`, {}, signal, 'GET')
    const items = data.items
    if (!Array.isArray(items)) return []
    return items
      .filter((model): model is MentalModel =>
        typeof model === 'object' && model !== null
        && typeof (model as MentalModel).id === 'string'
        && typeof (model as MentalModel).name === 'string'
        && typeof (model as MentalModel).content === 'string'
        && (model as MentalModel).content.trim().length > 0,
      )
      .map(model => ({ ...model, content: model.content.trim() }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  return { bankFor, recall, recallScoped, directives, retain, reflect, mentalModels }
}

export type Banks = ReturnType<typeof createBanks>

/** Re-export for callers that only want the error type. */
export { HindsightError }
