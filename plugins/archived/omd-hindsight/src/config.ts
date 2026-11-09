/**
 * Plugin configuration: the Standard-Schema validator for the `omd-hindsight`
 * row's `config`, and the resolved value the rest of the package reads.
 *
 * The config block REPLACES the plugin's defaults wholesale — list every key
 * you want to keep when you override one.
 *
 * @module omd-hindsight/config
 */

import z from '@deepseek-ai/schemastery'

/** How memories are partitioned across banks. */
export type Scoping = 'project' | 'global'

/** Raw, unvalidated plugin configuration, as it may arrive from the profile. */
export interface Config {
  /** Hindsight REST base URL. */
  baseUrl?: string
  /** Credential REFERENCE naming the API key (env → `~/.dsh/.credentials.yaml` → `.env`). Empty disables auth. */
  apiKeyRef?: string
  /** The shared bank every session reads; global-scope writes land here. */
  globalBank?: string
  /** `project` = per-project write bank merged with the global bank at recall. `global` = one bank for everything. */
  scoping?: Scoping
  /** Prefix for derived project bank ids. */
  projectBankPrefix?: string
  /** Explicit bank per project: key is the project's absolute path or its lowercased directory name. */
  projectBankMap?: Record<string, string>
  /** Token budget for the global leg of a merged recall (the project leg uses `maxRecallTokens`). */
  recallGlobalBudget?: number
  /** The per-turn automatic recall is active. */
  autoContext?: boolean
  /** Recall runs ahead, at `agent/turn-stopping`, so the next turn rarely waits. */
  prefetch?: boolean
  /** How many recent human turns ride along in a recall query. */
  recallContextTurns?: number
  /** Token budget for the project leg of a recall. */
  maxRecallTokens?: number
  /** Bound, in milliseconds, for one automatic recall pass. */
  autoContextTimeoutMs?: number
  /** `true`: retain acknowledges fast, extraction runs in the background. */
  retainAsync?: boolean
  /** Recall once more at `compaction/start` and inject the result where compaction cannot reach it. */
  preCompaction?: boolean
  /** Render the project bank's mental models as a system-prompt section. */
  mentalModels?: boolean
  /** Seconds between mental-model refreshes. */
  mentalModelRefreshSec?: number
  /** Mission text ensured on the global bank at first use. */
  globalMission?: string
  /** Mission text ensured on derived project banks at first use. */
  projectMission?: string
}

/** Resolved plugin configuration: every field concrete. */
export interface ResolvedConfig {
  baseUrl: string
  apiKeyRef: string
  globalBank: string
  scoping: Scoping
  projectBankPrefix: string
  projectBankMap: Record<string, string>
  recallGlobalBudget: number
  autoContext: boolean
  prefetch: boolean
  recallContextTurns: number
  maxRecallTokens: number
  autoContextTimeoutMs: number
  retainAsync: boolean
  preCompaction: boolean
  mentalModels: boolean
  mentalModelRefreshMs: number
  globalMission: string
  projectMission: string
}

/** Default mission for the shared bank, mirroring the omp deployment's. */
const DEFAULT_GLOBAL_MISSION =
  'You are an assistant using user conversation memory. Ground answers in the user\'s stated '
  + 'preferences, background, communication style, recurring topics, commitments, and open follow-ups. '
  + 'Avoid over-fitting to a single conversation.'

/** Default mission for derived project banks. */
const DEFAULT_PROJECT_MISSION =
  'You are a senior developer helping a coding agent. Prefer past technical decisions, '
  + 'architecture trade-offs, conventions, and constraints. Be direct when memory supports it.'

/**
 * Validate the row's `config` and fill defaults.
 * @param config - the profile row's config block, possibly empty.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const scoping = config.scoping ?? 'project'
  if (scoping !== 'project' && scoping !== 'global') {
    throw new Error(`omd-hindsight: scoping must be "project" or "global", got ${JSON.stringify(config.scoping)}`)
  }
  const mentalModelRefreshMs = (config.mentalModelRefreshSec ?? 300) * 1000
  if (!Number.isFinite(mentalModelRefreshMs) || mentalModelRefreshMs < 0) {
    throw new Error('omd-hindsight: mentalModelRefreshSec must be a non-negative number of seconds')
  }
  return {
    baseUrl: (config.baseUrl ?? 'http://127.0.0.1:8888').replace(/\/+$/, ''),
    apiKeyRef: config.apiKeyRef ?? 'HINDSIGHT_API_KEY',
    globalBank: config.globalBank ?? 'pi-global',
    scoping,
    projectBankPrefix: config.projectBankPrefix ?? 'dsh-project',
    projectBankMap: config.projectBankMap ?? {},
    recallGlobalBudget: config.recallGlobalBudget ?? 1024,
    autoContext: config.autoContext ?? true,
    prefetch: config.prefetch ?? true,
    recallContextTurns: config.recallContextTurns ?? 5,
    maxRecallTokens: config.maxRecallTokens ?? 4096,
    autoContextTimeoutMs: config.autoContextTimeoutMs ?? 2500,
    retainAsync: config.retainAsync ?? false,
    preCompaction: config.preCompaction ?? true,
    mentalModels: config.mentalModels ?? true,
    mentalModelRefreshMs,
    globalMission: config.globalMission ?? DEFAULT_GLOBAL_MISSION,
    projectMission: config.projectMission ?? DEFAULT_PROJECT_MISSION,
  }
}

/** Schemastery schema for the row's `config`. */
export const Config: z<Config> = z.object({
  baseUrl: z.string(),
  apiKeyRef: z.string(),
  globalBank: z.string(),
  scoping: z.union(['project', 'global']),
  projectBankPrefix: z.string(),
  projectBankMap: z.dict(z.string(), z.string()),
  recallGlobalBudget: z.number(),
  autoContext: z.boolean(),
  prefetch: z.boolean(),
  recallContextTurns: z.number(),
  maxRecallTokens: z.number(),
  autoContextTimeoutMs: z.number(),
  retainAsync: z.boolean(),
  preCompaction: z.boolean(),
  mentalModels: z.boolean(),
  mentalModelRefreshSec: z.number(),
  globalMission: z.string(),
  projectMission: z.string(),
})
