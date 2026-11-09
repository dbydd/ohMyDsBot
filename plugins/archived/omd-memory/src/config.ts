/**
 * Plugin configuration for `omd-memory`: the schemastery validator for the
 * profile row's `config`, the concrete shape the package reads, and
 * `resolveConfig`, which fills the defaults.
 *
 * Every default here describes the state "nothing was configured". None of
 * them names a machine: no address, no bank id, no pinned project. A profile
 * patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) carries the real
 * values, so a published copy of this package never leaks one machine's
 * topology.
 *
 * @module omd-memory/config
 */

import z from '@deepseek-ai/schemastery'

/** How a project is isolated inside the memory server. */
export type ScopeMode = 'domain-tagged' | 'isolated-bank'

/** Where the project identity comes from. */
export type ProjectIdStrategy = 'remote' | 'basename' | 'pin'

/** Server-side recall effort. */
export type RecallBudget = 'low' | 'mid' | 'high'

/** How a retain job writes over an existing document. */
export type RetainUpdateMode = 'append' | 'replace'

/** Which tool results survive projection into a retain job. */
export type RetainToolResults = 'errors-only' | 'none' | 'all'

/**
 * Raw plugin configuration, as the profile row supplies it. Every field is
 * optional; `resolveConfig` fills what is missing.
 */
export interface Config {
  enabled?: boolean
  baseUrl?: string
  apiKeyRef?: string
  timeoutMs?: number
  codingBank?: string
  bankPrefix?: string
  userBank?: string
  scopeMode?: ScopeMode
  projectIdStrategy?: ProjectIdStrategy
  projectId?: string
  includeSharedObservations?: boolean
  autoRecall?: boolean
  prefetch?: boolean
  recallEveryNTurns?: number
  recallBudget?: RecallBudget
  recallMaxTokens?: number
  recallTopK?: number
  recallTypes?: string[]
  recallContextTurns?: number
  recallMaxQueryChars?: number
  recallTimeoutMs?: number
  mentalModels?: boolean
  mentalModelsMaxChars?: number
  autoRetain?: boolean
  retainAsync?: boolean
  retainUpdateMode?: RetainUpdateMode
  retainToolResults?: RetainToolResults
  retainMaxContentChars?: number
  redactSecrets?: boolean
  flushIntervalMs?: number
  flushMaxJobsPerPass?: number
  shutdownFlushMs?: number
  queuePath?: string
}

/** Resolved configuration: every field concrete, every default applied. */
export interface ResolvedConfig {
  enabled: boolean
  baseUrl: string
  apiKeyRef: string
  timeoutMs: number
  codingBank: string
  bankPrefix: string
  userBank: string
  scopeMode: ScopeMode
  projectIdStrategy: ProjectIdStrategy
  projectId: string
  includeSharedObservations: boolean
  autoRecall: boolean
  prefetch: boolean
  recallEveryNTurns: number
  recallBudget: RecallBudget
  recallMaxTokens: number
  recallTopK: number
  recallTypes: string[]
  recallContextTurns: number
  recallMaxQueryChars: number
  recallTimeoutMs: number
  mentalModels: boolean
  mentalModelsMaxChars: number
  autoRetain: boolean
  retainAsync: boolean
  retainUpdateMode: RetainUpdateMode
  retainToolResults: RetainToolResults
  retainMaxContentChars: number
  redactSecrets: boolean
  flushIntervalMs: number
  flushMaxJobsPerPass: number
  shutdownFlushMs: number
  queuePath: string
}

/**
 * Which keys a per-project record may override. Everything outside this list
 * is profile-scoped only: an address, a credential reference, or a queue path
 * belongs to the deployment, not to one repository.
 */
export const PROJECT_OVERRIDABLE = [
  'codingBank',
  'userBank',
  'scopeMode',
  'autoRecall',
  'recallEveryNTurns',
  'recallBudget',
  'recallMaxTokens',
  'mentalModels',
  'includeSharedObservations',
  'autoRetain',
  'retainToolResults',
] as const

/** One key a per-project record may override. */
export type ProjectOverridableKey = typeof PROJECT_OVERRIDABLE[number]

/** The per-project override bag: a subset of the overridable keys. */
export type ProjectOverrides = Partial<Pick<ResolvedConfig, ProjectOverridableKey>>

/** Whether a key may be overridden per project. */
export function isProjectOverridable(key: string): key is ProjectOverridableKey {
  return (PROJECT_OVERRIDABLE as readonly string[]).includes(key)
}

/** The non-negative integer floor a count-like field accepts, shared by the validator and the resolver. */
function fail(message: string): never {
  throw new Error(`omd-memory: ${message}`)
}

/**
 * Validate one count or duration: a finite number at or above `min`.
 * @param name - field name, used in the diagnostic.
 * @param value - candidate value.
 * @param min - inclusive lower bound.
 * @returns the value, unchanged.
 */
function bounded(name: string, value: number, min: number): number {
  if (!Number.isFinite(value) || value < min) fail(`${name} must be a number >= ${min}, got ${JSON.stringify(value)}`)
  return value
}

/**
 * Validate the profile row's `config` and fill defaults. The row may carry no
 * config block at all, which arrives as `{}`; `Config` has already applied every
 * default by then, so an absent block resolves to the documented defaults.
 * @param config - the row's config block, possibly empty.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  // The Loader delivers an absent block as `{}` unvalidated, so every read is
  // normalized here rather than trusting a caller to have applied defaults:
  // `undefined` and the volatile `{}` carrier both mean "not configured".
  // Caution: the Loader does not run this schema, and what it hands over for
  // an absent block is not a validated object — every field arrives as a
  // descriptor object rather than its default. A descriptor is a shape this
  // function never produces, so any object-typed value that is not a string
  // list counts as "not configured" and falls back to the default.
  const given = (value: unknown): unknown =>
    value === undefined || (typeof value === 'object' && !Array.isArray(value)) ? undefined : value



  const input: Config = config !== null && typeof config === 'object' ? config : {}
  const scopeMode = (given(input.scopeMode) ?? 'domain-tagged') as ScopeMode
  if (scopeMode !== 'domain-tagged' && scopeMode !== 'isolated-bank') {
    fail(`scopeMode must be "domain-tagged" or "isolated-bank", got ${JSON.stringify(given(input.scopeMode))}`)
  }
  const projectIdStrategy = (given(input.projectIdStrategy) ?? 'remote') as ProjectIdStrategy
  if (projectIdStrategy !== 'remote' && projectIdStrategy !== 'basename' && projectIdStrategy !== 'pin') {
    fail(`projectIdStrategy must be "remote", "basename" or "pin", got ${JSON.stringify(given(input.projectIdStrategy))}`)
  }
  const recallBudget = (given(input.recallBudget) ?? 'mid') as RecallBudget
  if (recallBudget !== 'low' && recallBudget !== 'mid' && recallBudget !== 'high') {
    fail(`recallBudget must be "low", "mid" or "high", got ${JSON.stringify(given(input.recallBudget))}`)
  }
  const retainUpdateMode = (given(input.retainUpdateMode) ?? 'append') as RetainUpdateMode
  if (retainUpdateMode !== 'append' && retainUpdateMode !== 'replace') {
    fail(`retainUpdateMode must be "append" or "replace", got ${JSON.stringify(given(input.retainUpdateMode))}`)
  }
  const retainToolResults = (given(input.retainToolResults) ?? 'errors-only') as RetainToolResults
  if (retainToolResults !== 'errors-only' && retainToolResults !== 'none' && retainToolResults !== 'all') {
    fail(`retainToolResults must be "errors-only", "none" or "all", got ${JSON.stringify(given(input.retainToolResults))}`)
  }
  const projectId = (given(input.projectId) ?? '').trim()
  if (projectIdStrategy === 'pin' && projectId === '') {
    fail('projectIdStrategy is "pin" but projectId is empty')
  }
  return {
    enabled: given(input.enabled) ?? true,
    baseUrl: (given(input.baseUrl) ?? '').trim().replace(/\/+$/, ''),
    apiKeyRef: (given(input.apiKeyRef) ?? 'HINDSIGHT_API_KEY').trim(),
    timeoutMs: bounded('timeoutMs', given<number>(input.timeoutMs) ?? 30_000, 1),
    codingBank: (given(input.codingBank) ?? '').trim(),
    bankPrefix: (given(input.bankPrefix) ?? 'dsh-coding').trim(),
    userBank: (given(input.userBank) ?? '').trim(),
    scopeMode,
    projectIdStrategy,
    projectId,
    includeSharedObservations: given(input.includeSharedObservations) ?? false,
    autoRecall: given(input.autoRecall) ?? true,
    prefetch: given(input.prefetch) ?? true,
    recallEveryNTurns: bounded('recallEveryNTurns', given<number>(input.recallEveryNTurns) ?? 1, 1),
    recallBudget,
    recallMaxTokens: bounded('recallMaxTokens', given<number>(input.recallMaxTokens) ?? 800, 1),
    recallTopK: bounded('recallTopK', given<number>(input.recallTopK) ?? 8, 1),
    recallTypes: given(input.recallTypes) ?? ['observation'],
    recallContextTurns: bounded('recallContextTurns', given<number>(input.recallContextTurns) ?? 2, 0),
    recallMaxQueryChars: bounded('recallMaxQueryChars', given<number>(input.recallMaxQueryChars) ?? 800, 1),
    recallTimeoutMs: bounded('recallTimeoutMs', given<number>(input.recallTimeoutMs) ?? 40_000, 1),
    mentalModels: given(input.mentalModels) ?? true,
    mentalModelsMaxChars: bounded('mentalModelsMaxChars', given<number>(input.mentalModelsMaxChars) ?? 6_000, 1),
    autoRetain: given(input.autoRetain) ?? true,
    retainAsync: given(input.retainAsync) ?? true,
    retainUpdateMode,
    retainToolResults,
    retainMaxContentChars: bounded('retainMaxContentChars', given<number>(input.retainMaxContentChars) ?? 20_000, 1),
    redactSecrets: given(input.redactSecrets) ?? true,
    flushIntervalMs: bounded('flushIntervalMs', given<number>(input.flushIntervalMs) ?? 30_000, 1),
    flushMaxJobsPerPass: bounded('flushMaxJobsPerPass', given<number>(input.flushMaxJobsPerPass) ?? 4, 1),
    shutdownFlushMs: bounded('shutdownFlushMs', given<number>(input.shutdownFlushMs) ?? 2_000, 0),
    queuePath: (given(input.queuePath) ?? '').trim(),
  }
}

/**
 * Schemastery schema for the row's `config`. Volatile fields render in the
 * settings form and are editable without a restart; the rest describe where
 * the memory server and its queue live.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true)
    .volatile()
    .description('Master switch for the whole memory backend. Off registers no recall, no retain and no flush.'),
  baseUrl: z.string().default('')
    .volatile()
    .description('Hindsight server base URL. Empty means "not configured": no localhost fallback, calls report the missing address instead of failing a turn.'),
  apiKeyRef: z.string().default('HINDSIGHT_API_KEY')
    .volatile()
    .description('Credential reference naming the API key; the value is read through ctx.credentials, never stored here.'),
  timeoutMs: z.number().default(30_000)
    .volatile()
    .description('Upper bound on one HTTP call to the memory server.'),
  codingBank: z.string().default('')
    .volatile()
    .description('Explicit coding bank id. Empty derives it from bankPrefix and the project identity. Per-project overridable.'),
  bankPrefix: z.string().default('dsh-coding')
    .volatile()
    .description('Prefix of a derived bank id: `<bankPrefix>-<project id>`.'),
  userBank: z.string().default('')
    .volatile()
    .description('Shared bank for cross-project memories. Empty disables it: explicit retain is then the only writer and recall reads the coding bank alone. Per-project overridable.'),
  scopeMode: z.union(['domain-tagged', 'isolated-bank']).default('domain-tagged')
    .volatile()
    .description('`domain-tagged` keeps every project in one bank and separates them by tags; `isolated-bank` gives each project its own bank. Per-project overridable.'),
  projectIdStrategy: z.union(['remote', 'basename', 'pin']).default('remote')
    .volatile()
    .description('Where the project identity comes from: the git remote, the directory basename, or the pinned projectId.'),
  projectId: z.string().default('')
    .volatile()
    .description('Identity pinned when projectIdStrategy is "pin". Empty with "pin" is a configuration error.'),
  includeSharedObservations: z.boolean().default(false)
    .volatile()
    .description('Recall also returns bank-wide observations that carry no tag at all. Per-project overridable.'),
  autoRecall: z.boolean().default(true)
    .volatile()
    .description('Recall automatically at the start of a turn. Per-project overridable.'),
  prefetch: z.boolean().default(true)
    .volatile()
    .description('Start the next turn\'s recall at the current turn\'s stop boundary, so the next turn rarely waits.'),
  recallEveryNTurns: z.number().step(1).min(1).default(1)
    .volatile()
    .description('Run automatic recall once every N turns; 1 means every turn. Per-project overridable.'),
  recallBudget: z.union(['low', 'mid', 'high']).default('mid')
    .volatile()
    .description('Server-side recall effort. Per-project overridable.'),
  recallMaxTokens: z.number().default(800)
    .volatile()
    .description('Token budget of one project-bank recall. Per-project overridable.'),
  recallTopK: z.number().step(1).min(1).default(8)
    .volatile()
    .description('Maximum number of recalled results rendered into the block.'),
  recallTypes: z.array(z.string()).default(['observation'])
    .volatile()
    .description('Fact types a recall asks for: `observation`, `world`, `experience`.'),
  recallContextTurns: z.number().step(1).min(0).default(2)
    .volatile()
    .description('How many preceding turns of the session ride along in the recall query.'),
  recallMaxQueryChars: z.number().step(1).min(1).default(800)
    .volatile()
    .description('Truncation limit on the composed recall query.'),
  recallTimeoutMs: z.number().min(1).default(40_000)
    .volatile()
    .description('Upper bound on one recall, prefetch included. A timeout records a miss; it never fails the turn.'),
  mentalModels: z.boolean().default(true)
    .volatile()
    .description('Append the bank\'s mental models to the recalled block. Per-project overridable.'),
  mentalModelsMaxChars: z.number().step(1).min(1).default(6_000)
    .volatile()
    .description('Character budget for the mental-model appendix.'),
  autoRetain: z.boolean().default(true)
    .volatile()
    .description('Write a finished turn to memory at the turn stop boundary. Per-project overridable.'),
  retainAsync: z.boolean().default(true)
    .volatile()
    .description('Ask the server to extract in the background, so a delivery returns before extraction finishes.'),
  retainUpdateMode: z.union(['append', 'replace']).default('append')
    .volatile()
    .description('How a job writes over an existing document: `append` extends it, `replace` overwrites it.'),
  retainToolResults: z.union(['errors-only', 'none', 'all']).default('errors-only')
    .volatile()
    .description('Which tool results survive projection: only failures, none, or every result. Per-project overridable.'),
  retainMaxContentChars: z.number().step(1).min(1).default(20_000)
    .volatile()
    .description('Cap on one job\'s content, and therefore the projection\'s retained window.'),
  redactSecrets: z.boolean().default(true)
    .volatile()
    .description('Redact credentials and secret-looking values from a job before it is queued.'),
  flushIntervalMs: z.number().step(1).min(1).default(30_000)
    .volatile()
    .description('Interval of the background delivery pass.'),
  flushMaxJobsPerPass: z.number().step(1).min(1).default(4)
    .volatile()
    .description('Jobs one delivery pass may send. The pass never runs longer than the queue granularity allows.'),
  shutdownFlushMs: z.number().step(1).min(0).default(2_000)
    .volatile()
    .description('Time the shutdown flush may spend delivering. Whatever is left stays on disk for the next start.'),
  queuePath: z.string().default('')
    .description('Queue file path. Empty means `dshHomePath(\'memory\', \'retain-queue.jsonl\')`. Not shown in the settings form.'),
})
