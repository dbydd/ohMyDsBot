/**
 * Project-level Hindsight configuration, owned by omd-hindsight.
 *
 * One JSON document per Bot working directory lives at
 * `<DSH_HOME or ~/.dsh>/data/omd-hindsight/projects/<sha256(project)>.json`.
 * Keys are absolute session cwds, so two Bots opened on different checkouts
 * keep different default banks, write policies and recall parameters. Writes
 * are serialized per project, revision-guarded, and atomic (temp file + rename).
 *
 * @module omd-hindsight/project-config
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ProjectHindsightValues, RetainMode } from './config.ts'
import { isRecord } from './core/guards.ts'
import { CONFIG_KEYS, type ConfigKeySpec } from '../ssot/spec.ts'

const PROJECT_CONFIG_VERSION = 1

const RETAIN_MODES: readonly RetainMode[] = ['auto', 'decision', 'manual', 'off', 'explicit']

/** Numeric bounds for the two tunable recall parameters. */
const VALUE_LIMITS = {
  recallMaxItems: { min: 1, max: 64 },
  recallPreviewChars: { min: 40, max: 4000 },
} as const

const PROJECT_VALUE_KEYS = [
  'enabled', 'defaultBank', 'retain', 'recallMaxItems', 'recallPreviewChars',
  'baseUrl', 'apiKeyEnvVar', 'decomposerRole', 'recallDebounceTurns', 'recallBudget',
  'recallInjectJudge', 'recallRerankJudge', 'recallInSubagents',
] as const

export type ProjectValueKey = (typeof PROJECT_VALUE_KEYS)[number]

/** One editable project value; the single source for validation and the form schema. */
export interface ProjectValueSpec {
  readonly key: ProjectValueKey
  readonly title: string
  readonly description: string
  readonly type: 'boolean' | 'string' | 'number'
  /** Fixed label set; `defaultBank` fills its set from the live roster. */
  readonly enum?: readonly string[]
  readonly minimum?: number
  readonly maximum?: number
}

const PROJECT_VALUE_SPECS: readonly ProjectValueSpec[] = [
  {
    key: 'enabled',
    title: '启用项目记忆',
    description: '控制当前工作目录中的记忆请求。',
    type: 'boolean',
  },
  {
    key: 'defaultBank',
    title: '默认记忆库',
    description: '没有指定目标时使用的记忆库。',
    type: 'string',
  },
  {
    key: 'retain',
    title: '写入策略',
    description: '应用到本项目各记忆库的写入策略。',
    type: 'string',
    enum: RETAIN_MODES,
  },
  {
    key: 'recallMaxItems',
    title: '召回条数',
    description: '每次手动召回最多返回的事实条数。',
    type: 'number',
    minimum: VALUE_LIMITS.recallMaxItems.min,
    maximum: VALUE_LIMITS.recallMaxItems.max,
  },
  {
    key: 'recallPreviewChars',
    title: '预览长度',
    description: '召回回执中每条事实最多显示的字符数。',
    type: 'number',
    minimum: VALUE_LIMITS.recallPreviewChars.min,
    maximum: VALUE_LIMITS.recallPreviewChars.max,
  },
]

/** Reference console keys use the core declarations for their type and choices. */
const ROW_CONSOLE_KEYS = [
  'baseUrl', 'apiKeyEnvVar', 'decomposerRole', 'recallDebounceTurns', 'recallBudget',
  'recallInjectJudge', 'recallRerankJudge', 'recallInSubagents',
] as const

const CONSOLE_TITLES: Readonly<Record<(typeof ROW_CONSOLE_KEYS)[number], string>> = {
  baseUrl: '服务地址',
  apiKeyEnvVar: '密钥环境变量名',
  decomposerRole: '意图解构角色',
  recallDebounceTurns: '召回防抖轮数',
  recallBudget: '召回预算',
  recallInjectJudge: '注入前判断',
  recallRerankJudge: '候选重排判断',
  recallInSubagents: '子代理自动召回',
}

export interface ConfigSchemaProperty {
  readonly type: 'string' | 'number' | 'boolean' | 'array'
  readonly description: string
  readonly title?: string
  readonly enum?: readonly string[]
  readonly minimum?: number
  readonly maximum?: number
  readonly default?: unknown
  /** Which layer owns the value; only `project` values are accepted by a project-config write. */
  readonly 'x-scope': 'project' | 'row'
}

/** The JSON Schema the config panel renders; derived from the same tables that validate writes. */
export interface ProjectConfigSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, ConfigSchemaProperty>>
}

const ENUM_CONSTRAINT = /^[a-z][a-z0-9_-]*(?:\s*\|\s*[a-z][a-z0-9_-]*)+$/

function rowProperty(spec: ConfigKeySpec): ConfigSchemaProperty {
  const enumValues = spec.constraint !== undefined && ENUM_CONSTRAINT.test(spec.constraint)
    ? spec.constraint.split('|').map(part => part.trim())
    : undefined
  return {
    type: spec.type === 'string[]' ? 'array' : spec.type === 'json' ? 'array' : spec.type,
    description: spec.constraint ?? '',
    ...(enumValues === undefined ? {} : { enum: enumValues }),
    ...(spec.default === undefined ? {} : { default: spec.default }),
    'x-scope': 'project',
  }
}

/**
 * Derive the config form's schema. Project-scoped properties are exactly the keys
 * `validateProjectValues` accepts; row-scoped ones come from the host's own config
 * declarations, so no client keeps a second field list.
 */
export function projectConfigSchema(bankIds: ReadonlySet<string>): ProjectConfigSchema {
  const properties: Record<string, ConfigSchemaProperty> = {}
  for (const spec of PROJECT_VALUE_SPECS) {
    properties[spec.key] = {
      type: spec.type,
      title: spec.title,
      description: spec.description,
      ...(spec.key === 'defaultBank'
        ? { enum: [...bankIds] }
        : spec.enum === undefined ? {} : { enum: spec.enum }),
      ...(spec.minimum === undefined ? {} : { minimum: spec.minimum }),
      ...(spec.maximum === undefined ? {} : { maximum: spec.maximum }),
      'x-scope': 'project',
    }
  }
  for (const key of ROW_CONSOLE_KEYS) {
    const spec = CONFIG_KEYS[key]
    if (spec !== undefined) properties[key] = {
      ...rowProperty(spec),
      title: CONSOLE_TITLES[key],
      ...(key === 'recallDebounceTurns' ? { minimum: 0 } : {}),
    }
  }
  return { type: 'object', properties }
}

export interface ProjectConfigDocument {
  readonly version: 1
  readonly revision: number
  readonly project: string
  readonly hindsight: ProjectHindsightValues
}

export class ProjectConfigError extends Error {
  readonly code: 'invalid' | 'conflict'

  constructor(message: string, code: 'invalid' | 'conflict') {
    super(message)
    this.name = 'ProjectConfigError'
    this.code = code
  }
}

/** Canonical key: an absolute, resolved path (trailing slashes and `..` folded). */
function normalizeProject(project: string): string {
  const trimmed = project.trim()
  if (trimmed.length === 0) {
    throw new ProjectConfigError('project must be a non-empty absolute path (the Bot session cwd)', 'invalid')
  }
  if (!isAbsolute(trimmed)) {
    throw new ProjectConfigError(`project ${JSON.stringify(trimmed)} must be an absolute path (the Bot session cwd)`, 'invalid')
  }
  return resolve(trimmed)
}

/** File name for a project; the document records the project to detect collisions. */
function projectConfigFile(project: string, dir: string): string {
  return join(dir, `${createHash('sha256').update(project).digest('hex')}.json`)
}

function integerInRange(key: 'recallMaxItems' | 'recallPreviewChars', value: unknown): number {
  const limit = VALUE_LIMITS[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < limit.min || value > limit.max) {
    throw new ProjectConfigError(
      `${key} must be an integer between ${limit.min} and ${limit.max} (got ${JSON.stringify(value)})`,
      'invalid',
    )
  }
  return value
}

/**
 * Validate a sparse patch of project values against the profile row's bank roster.
 * Every rejection names the offending key, the accepted set and the received value.
 */
export function validateProjectValues(raw: unknown, bankIds: ReadonlySet<string>): ProjectHindsightValues {
  if (!isRecord(raw)) {
    throw new ProjectConfigError('values must be an object with the project overrides', 'invalid')
  }
  const values: ProjectHindsightValues = {}
  for (const key of Object.keys(raw)) {
    if (!PROJECT_VALUE_KEYS.some(candidate => candidate === key)) {
      throw new ProjectConfigError(
        `unknown key ${JSON.stringify(key)}; accepted keys: ${PROJECT_VALUE_KEYS.join(', ')}`,
        'invalid',
      )
    }
  }

  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') {
      throw new ProjectConfigError(`enabled must be a boolean (got ${JSON.stringify(raw.enabled)})`, 'invalid')
    }
    values.enabled = raw.enabled
  }
  if ('defaultBank' in raw) {
    const bank = raw.defaultBank
    if (typeof bank !== 'string' || !bankIds.has(bank)) {
      throw new ProjectConfigError(
        `defaultBank ${JSON.stringify(bank)} is not a declared bank id (${[...bankIds].join(', ')})`,
        'invalid',
      )
    }
    values.defaultBank = bank
  }
  if ('retain' in raw) {
    const rawRetain = raw.retain
    const mode = typeof rawRetain === 'string'
      ? RETAIN_MODES.find(candidate => candidate === rawRetain)
      : undefined
    if (mode === undefined) {
      throw new ProjectConfigError(
        `retain must be one of ${RETAIN_MODES.join(' | ')} (got ${JSON.stringify(rawRetain)})`,
        'invalid',
      )
    }
    values.retain = mode
  }
  if ('recallMaxItems' in raw) {
    values.recallMaxItems = integerInRange('recallMaxItems', raw.recallMaxItems)
  }
  if ('recallPreviewChars' in raw) {
    values.recallPreviewChars = integerInRange('recallPreviewChars', raw.recallPreviewChars)
  }
  for (const key of ROW_CONSOLE_KEYS) {
    if (!(key in raw)) continue
    const value = raw[key]
    const spec = rowProperty(CONFIG_KEYS[key])
    if (typeof value !== spec.type) {
      throw new ProjectConfigError(`${key} must be a ${spec.type}`, 'invalid')
    }
    if (spec.enum !== undefined && !spec.enum.includes(String(value))) {
      throw new ProjectConfigError(`${key} must be one of ${spec.enum.join(' | ')}`, 'invalid')
    }
    if (key === 'recallDebounceTurns' && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
      throw new ProjectConfigError(`${key} must be a non-negative integer`, 'invalid')
    }
    Object.assign(values, { [key]: value })
  }
  return values
}

function emptyDocument(project: string): ProjectConfigDocument {
  return { version: PROJECT_CONFIG_VERSION, revision: 0, project, hindsight: {} }
}

function parseDocument(raw: string, project: string): ProjectConfigDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ProjectConfigError(
      `stored project config for ${project} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'invalid',
    )
  }
  if (!isRecord(parsed) || parsed.version !== PROJECT_CONFIG_VERSION) {
    throw new ProjectConfigError(`stored project config for ${project} has an unsupported version`, 'invalid')
  }
  if (parsed.project !== project) {
    throw new ProjectConfigError(
      `stored project config for ${project} names ${JSON.stringify(parsed.project)} (hash collision)`,
      'invalid',
    )
  }
  if (typeof parsed.revision !== 'number' || !Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new ProjectConfigError(`stored project config for ${project} has an invalid revision`, 'invalid')
  }
  if (!isRecord(parsed.hindsight)) {
    throw new ProjectConfigError(`stored project config for ${project} has invalid hindsight values`, 'invalid')
  }
  return {
    version: PROJECT_CONFIG_VERSION,
    revision: parsed.revision,
    project,
    hindsight: parsed.hindsight as ProjectHindsightValues,
  }
}

export class ProjectConfigStore {
  readonly #dir: string
  readonly #chains = new Map<string, Promise<unknown>>()

  constructor(dir: string = dshHomePath('data', 'omd-hindsight', 'projects')) {
    this.#dir = dir
  }

  async read(project: string): Promise<ProjectConfigDocument> {
    const canonical = normalizeProject(project)
    try {
      return parseDocument(await readFile(projectConfigFile(canonical, this.#dir), 'utf8'), canonical)
    } catch (error) {
      if (isNotFound(error)) return emptyDocument(canonical)
      throw error
    }
  }

  /** Write a whole replacement document; returns the new revision. */
  async write(
    project: string,
    expectedRevision: number,
    values: ProjectHindsightValues,
  ): Promise<ProjectConfigDocument> {
    const canonical = normalizeProject(project)
    return await this.#serialize(canonical, async () => {
      const current = await this.read(canonical)
      if (current.revision !== expectedRevision) {
        throw new ProjectConfigError(
          `revision conflict: expected ${expectedRevision}, current ${current.revision}; reload the panel before saving`,
          'conflict',
        )
      }
      const next: ProjectConfigDocument = {
        version: PROJECT_CONFIG_VERSION,
        revision: current.revision + 1,
        project: canonical,
        hindsight: values,
      }
      const target = projectConfigFile(canonical, this.#dir)
      await mkdir(this.#dir, { recursive: true })
      const temp = `${target}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temp, target)
      return next
    })
  }

  /** Chain writes for one project so two concurrent saves cannot both win. */
  async #serialize<T>(project: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(project) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    this.#chains.set(project, run)
    try {
      return await run
    } finally {
      if (this.#chains.get(project) === run) this.#chains.delete(project)
    }
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
