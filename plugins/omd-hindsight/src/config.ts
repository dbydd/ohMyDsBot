/**
 * Plugin configuration: Schemastery schema for the `omd-hindsight` row and
 * the bridge from the dsh profile row to the core's `HindsightConfig`.
 *
 * @module omd-hindsight/config
 */

import z from '@deepseek-ai/schemastery'
import { parseConfig } from './core/config.ts'
import type {
  BankAccess,
  BankConfig,
  HindsightConfig,
  ObservationScopes,
  RetainMode as CoreRetainMode,
} from './core/types.ts'

export type RetainMode = 'auto' | 'decision' | 'manual' | 'off' | 'explicit'
export type { BankAccess, BankConfig, HindsightConfig, ObservationScopes }

/** One configured bank specification from the profile row. */
export interface BankSpec {
  /** Unique short name; defaults to map key. */
  id?: string
  /** Remote bank id on the backend; defaults to id. */
  bankId?: string
  /** Business description used by the judge to select the bank. */
  description?: string
  /** Access level: "read" or "read-write". Defaults to "read-write". */
  access?: BankAccess
  /** Write policy: "auto" | "decision" | "manual" | "explicit" | "off". Defaults to "auto". */
  retain?: RetainMode
  /** Observation scopes for extraction; defaults to "per_tag". */
  scopes?: ObservationScopes
  /** Whether the bank can be automatically selected without explicit target. Defaults to true. */
  autoTarget?: boolean
}

/** Raw plugin configuration from profile row. */
export interface Config {
  /** false keeps the plugin inert. */
  enabled?: boolean
  /** Base URL of the Hindsight HTTP backend. Defaults to http://localhost:8888. */
  baseUrl?: string
  /** Environment variable name holding the API key. Defaults to HINDSIGHT_API_KEY. */
  apiKeyEnvVar?: string
  /** HTTP request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  /** The bank map. Required and non-empty. */
  banks?: Record<string, BankSpec>
  /** Which bank a request with no explicit target prefers. Defaults to first bank. */
  defaultBank?: string
  /** Judge confidence below which intent is ambiguous. Defaults to 0.35. */
  judgeAmbiguousConfidence?: number
  /** Maximum facts returned per recall. Defaults to 8. */
  recallMaxItems?: number
  /** Maximum preview characters in recall receipts; defaults to the core spec value. */
  recallPreviewChars?: number
  /** Role used by the entry decomposer. Defaults to the core spec value. */
  decomposerRole?: string
  /** Automatic recall trigger points; the core spec default applies when omitted. */
  recallTriggers?: string[]
  /** every-turn | every-n-turns | explicit-only. */
  recallMode?: string
  /** Cycle of `every-n-turns`. */
  recallEveryNTurns?: number
  /** Consecutive unchanged focuses before recall stops refreshing. */
  recallDebounceTurns?: number
  /** low | mid | high. */
  recallBudget?: string
  /** Whether subagent sessions may recall. */
  recallInSubagents?: boolean
  /** Whether the inject decision is asked before injecting. */
  recallInjectJudge?: boolean
  /** Whether candidates are reranked by the judge. */
  recallRerankJudge?: boolean
  /** Candidates kept per recall. */
  recallTopK?: number
  /** Candidates sent to the rerank. */
  recallRerankCandidateLimit?: number
  /** Anti-pattern facts injected per recall. */
  recallAntiPatternLimit?: number
  /** Minimum milliseconds between two recalls. */
  recallMinIntervalMs?: number
  /** Total budget of one automatic recall. */
  injectTimeoutMs?: number
  /** Per-bank retrieval timeout. */
  recallTimeoutMs?: number
  /** Maximum attempts for offline retry queue. Defaults to 5. */
  retryQueueMaxAttempts?: number
  /** Deprecated local storage root. */
  storageRoot?: string
}

/** Resolved configuration produced by parseConfig. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly core: HindsightConfig
  readonly banks: readonly BankConfig[]
  readonly bankIds: ReadonlySet<string>
  readonly defaultBank: string
  readonly baseUrl: string
  readonly judgeAmbiguousConfidence: number
  readonly recallMaxItems: number
  readonly recallPreviewChars: number
}

const BANK_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Validate profile row config and map into core HindsightConfig via core parseConfig.
 *
 * @param config - profile row config
 * @param _homeRoot - optional home root for backward compatibility
 */
export function resolveConfig(config: Config = {}, _homeRoot?: string): ResolvedConfig {
  const enabled = config.enabled ?? true
  const entries = Object.entries(config.banks ?? {})

  if (entries.length === 0) {
    if (!enabled) {
      // Disabled with no banks is valid inert configuration
      const emptyParsed = parseConfig({
        baseUrl: 'http://localhost:8888',
        enabled: false,
        banks: [
          {
            id: 'dummy',
            bankId: 'dummy',
            description: 'dummy',
            access: 'read',
            retain: { mode: 'off', scopes: 'per_tag' },
          },
        ],
      })
      const emptyCore = emptyParsed.ok ? emptyParsed.config : ({} as HindsightConfig)
      return {
        enabled: false,
        core: emptyCore,
        banks: [],
        bankIds: new Set(),
        defaultBank: '',
        baseUrl: (config.baseUrl ?? 'http://localhost:8888').trim().replace(/\/+$/u, ''),
        judgeAmbiguousConfidence: 0.35,
        recallMaxItems: 8,
        recallPreviewChars: 600,
      }
    }
    throw new Error(
      'omd-hindsight: `banks` is required and must list at least one bank. '
      + 'The plugin stays inert without a bank roster — there is nothing for the judge to route to.',
    )
  }

  const rawBanks: Array<Record<string, unknown>> = []
  for (const [key, spec] of entries) {
    if (typeof spec !== 'object' || spec === null) {
      throw new Error(`omd-hindsight: banks.${key} must be an object with description, access, retain`)
    }
    const id = (spec.id ?? key).trim()
    if (!BANK_ID.test(id)) {
      throw new Error(
        `omd-hindsight: banks.${key}.id ${JSON.stringify(id)} must match ${BANK_ID.source} — `
        + 'it is a path segment and a judge option',
      )
    }
    const description = (spec.description ?? '').trim()
    if (description.length === 0) {
      throw new Error(
        `omd-hindsight: banks.${id}.description is required — the judge selects a bank by its description, `
        + 'a bank without one is unselectable',
      )
    }

    const retainRaw = spec.retain ?? 'auto'
    const retainMode: CoreRetainMode = retainRaw === 'explicit' ? 'manual' : retainRaw

    rawBanks.push({
      id,
      bankId: (spec.bankId ?? id).trim(),
      description,
      access: spec.access ?? 'read-write',
      recall: {
        enabled: true,
        maxTokens: config.recallMaxItems ? config.recallMaxItems * 150 : 1200,
        coldStart: 'recall',
        tags: [],
        tagsMatch: 'any_strict',
      },
      retain: {
        mode: retainMode,
        scopes: spec.scopes ?? 'per_tag',
        autoTarget: spec.autoTarget ?? true,
      },
    })
  }

  const baseUrl = (config.baseUrl ?? 'http://localhost:8888').trim().replace(/\/+$/u, '')
  const rawGlobal: Record<string, unknown> = {
    baseUrl,
    apiKeyEnvVar: config.apiKeyEnvVar ?? 'HINDSIGHT_API_KEY',
    timeoutMs: config.timeoutMs ?? 30000,
    enabled,
    promptPack: 'default',
    judgeAmbiguousConfidence: config.judgeAmbiguousConfidence ?? 0.35,
    retryQueueMaxAttempts: config.retryQueueMaxAttempts ?? 5,
    banks: rawBanks,
  }
  // Omitted knobs fall through to the core spec default; a row that names one
  // overrides it and is validated by the same CONFIG_KEYS tree.
  for (const key of [
    'decomposerRole', 'recallTriggers', 'recallMode', 'recallEveryNTurns',
    'recallDebounceTurns', 'recallBudget', 'recallInSubagents', 'recallInjectJudge',
    'recallRerankJudge', 'recallTopK', 'recallRerankCandidateLimit',
    'recallAntiPatternLimit', 'recallMinIntervalMs', 'injectTimeoutMs', 'recallTimeoutMs',
    'recallPreviewChars',
  ] as const) {
    if (config[key] !== undefined) rawGlobal[key] = config[key]
  }

  const parseResult = parseConfig(rawGlobal)
  if (!parseResult.ok) {
    const details = parseResult.problems.map(p => `  - ${p.key}: ${p.message}`).join('\n')
    throw new Error(`omd-hindsight: configuration validation failed:\n${details}`)
  }

  const core = parseResult.config
  const bankIds = new Set(core.banks.map(bank => bank.id))
  const defaultBank = (config.defaultBank ?? core.banks[0]?.id ?? '').trim()
  if (!bankIds.has(defaultBank)) {
    throw new Error(
      `omd-hindsight: defaultBank ${JSON.stringify(defaultBank)} is not a declared bank id `
      + `(${[...bankIds].join(', ')})`,
    )
  }

  return {
    enabled: core.enabled,
    core,
    banks: core.banks,
    bankIds,
    defaultBank,
    baseUrl: core.baseUrl,
    judgeAmbiguousConfidence: core.judgeAmbiguousConfidence,
    recallMaxItems: config.recallMaxItems ?? 8,
    recallPreviewChars: core.recallPreviewChars,
  }
}

/** Schemastery schema for the row's `config`. */
export const ConfigSchema: z<Config> = z.object({
  enabled: z.boolean().default(true).description('`false` keeps the plugin inert.'),
  baseUrl: z.string().description('Base URL of the Hindsight HTTP backend; defaults to http://localhost:8888.'),
  apiKeyEnvVar: z.string().description('Environment variable holding the API key. Default HINDSIGHT_API_KEY.'),
  timeoutMs: z.number().description('HTTP request timeout in ms. Default 30000.'),
  banks: z.dict(z.object({
    id: z.string().description('Unique short name; defaults to map key.'),
    bankId: z.string().description('Remote bank id on backend; defaults to id.'),
    description: z.string().description('What the bank holds; judge reads it as selection criterion.'),
    access: z.union(['read', 'read-write']).description('`read` banks refuse every write.'),
    retain: z.union(['auto', 'decision', 'manual', 'explicit', 'off']).description('Write policy.'),
    autoTarget: z.boolean().description('`false` excludes the bank from automatic target selection.'),
  })).required().description('Bank roster; required and non-empty.'),
  defaultBank: z.string().description('Bank a target-less request prefers; defaults to first declared bank.'),
  judgeAmbiguousConfidence: z.number().description('Judge confidence below this is ambiguous. Default 0.35.'),
  recallMaxItems: z.number().description('Maximum facts per recall. Default 8.'),
  recallPreviewChars: z.number().description('Recall fact preview length; defaults to the core spec value.'),
  decomposerRole: z.string().description('Entry decomposer role; defaults to the core spec value.'),
  recallTriggers: z.array(z.string()).description('Recall trigger points: context | prompt | turn-end.'),
  recallMode: z.string().description('every-turn | every-n-turns | explicit-only.'),
  recallEveryNTurns: z.number().description('Cycle of the every-n-turns mode.'),
  recallDebounceTurns: z.number().description('Unchanged-focus repeats allowed before recall stops.'),
  recallBudget: z.string().description('Retrieval budget: low | mid | high.'),
  recallInSubagents: z.boolean().description('Whether subagent sessions may recall.'),
  recallInjectJudge: z.boolean().description('Ask the inject decision before injecting.'),
  recallRerankJudge: z.boolean().description('Rerank candidates with the judge.'),
  recallTopK: z.number().description('Candidates kept per recall.'),
  recallRerankCandidateLimit: z.number().description('Candidates sent to the rerank.'),
  recallAntiPatternLimit: z.number().description('Anti-pattern facts injected per recall.'),
  recallMinIntervalMs: z.number().description('Minimum milliseconds between two recalls.'),
  injectTimeoutMs: z.number().description('Total budget of one automatic recall.'),
  recallTimeoutMs: z.number().description('Per-bank retrieval timeout in milliseconds.'),
  retryQueueMaxAttempts: z.number().description('Max attempts for offline retry queue. Default 5.'),
  storageRoot: z.string().description('Deprecated local storage root.'),
})

/**
 * Project-level overrides keyed by the Bot's absolute session working directory.
 * Sparse by design: an absent key means "keep the profile row's value".
 */
export interface ProjectHindsightValues {
  /** `false` short-circuits every memory request issued from this project. */
  enabled?: boolean
  /** Bank a target-less request prefers. Must name a declared bank. */
  defaultBank?: string
  /** Write policy applied to every bank of this project. */
  retain?: RetainMode
  /** Maximum facts returned per recall. */
  recallMaxItems?: number
  /** Maximum preview characters in recall receipts. */
  recallPreviewChars?: number
  /** Project-specific backend URL. */
  baseUrl?: string
  /** Credential environment variable name; never its value. */
  apiKeyEnvVar?: string
  /** Role used for intent decomposition. */
  decomposerRole?: string
  /** Consecutive unchanged recall opportunities before debouncing. */
  recallDebounceTurns?: number
  /** Retrieval budget for automatic recall. */
  recallBudget?: string
  /** Whether automatic recall uses the injection judge. */
  recallInjectJudge?: boolean
  /** Whether automatic recall uses the reranking judge. */
  recallRerankJudge?: boolean
  /** Whether child agents may automatically recall. */
  recallInSubagents?: boolean
}

/** Fold project overrides into the profile row before the normal resolver runs. */
export function withProjectOverrides(row: Config, overrides: ProjectHindsightValues): Config {
  const banks = overrides.retain === undefined || row.banks === undefined
    ? row.banks
    : Object.fromEntries(
      Object.entries(row.banks).map(([key, spec]) => [key, { ...spec, retain: overrides.retain }]),
    )
  return {
    ...row,
    ...overrides,
    banks,
  }
}

/** Resolve the profile row with one project's overrides applied. */
export function resolveProjectConfig(row: Config, overrides: ProjectHindsightValues): ResolvedConfig {
  return resolveConfig(withProjectOverrides(row, overrides))
}

/** The wire shape of `effective` in the project-config API and internal path. */
export interface EffectiveConfigView {
  readonly enabled: boolean
  readonly defaultBank: string
  readonly retain: RetainMode | null
  readonly recallMaxItems: number
  readonly recallPreviewChars: number
  readonly baseUrl: string
  readonly apiKeyEnvVar: string
  readonly decomposerRole: string
  readonly recallDebounceTurns: number
  readonly recallBudget: string
  readonly recallInjectJudge: boolean
  readonly recallRerankJudge: boolean
  readonly recallInSubagents: boolean
  readonly banks: readonly {
    readonly id: string
    readonly bankId: string
    readonly access: BankAccess
    readonly retain: string
    readonly autoTarget: boolean
  }[]
}

/** Describe the values actually in force for one project, for the config panel. */
export function effectiveView(resolved: ResolvedConfig, overrides: ProjectHindsightValues): EffectiveConfigView {
  return {
    enabled: resolved.enabled,
    defaultBank: resolved.defaultBank,
    retain: overrides.retain ?? null,
    recallMaxItems: resolved.recallMaxItems,
    recallPreviewChars: resolved.recallPreviewChars,
    baseUrl: resolved.core.baseUrl,
    apiKeyEnvVar: resolved.core.apiKeyEnvVar,
    decomposerRole: resolved.core.decomposerRole,
    recallDebounceTurns: resolved.core.recallDebounceTurns,
    recallBudget: resolved.core.recallBudget,
    recallInjectJudge: resolved.core.recallInjectJudge,
    recallRerankJudge: resolved.core.recallRerankJudge,
    recallInSubagents: resolved.core.recallInSubagents,
    banks: resolved.banks.map(bank => ({
      id: bank.id,
      bankId: bank.bankId,
      access: bank.access,
      retain: bank.retain.mode,
      autoTarget: bank.retain.autoTarget,
    })),
  }
}
