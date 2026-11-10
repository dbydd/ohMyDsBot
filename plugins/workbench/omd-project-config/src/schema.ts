/**
 * Render-free configuration vocabulary for one project: the field table, the
 * three-layer merge (plugin defaults → repository file → personal override),
 * and the validation schema both persisted layers share.
 *
 * The table is closed on purpose: a typo in `.omd/config.json` or in a stored
 * override becomes a loud error instead of a value nobody reads. Renderers
 * derive their form from the same table, so adding a field means adding one
 * row here.
 *
 * @module omd-project-config/schema
 */

import { z } from 'zod'

/** Where one field's effective value came from. */
export type FieldSource = 'default' | 'repo' | 'user'

/** One effective value plus the layer that supplied it. */
export interface ResolvedField<T> {
  /** Effective value after merging the three layers. */
  readonly value: T
  /** Highest layer that names the field. */
  readonly source: FieldSource
}

const roleRouteSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
}).strict()

/** One layer file's accepted shape; unknown keys fail validation. */
export const configLayerSchema = z.object({
  memory: z.object({
    enabled: z.boolean().optional(),
    /** A non-empty bank name, or null for "derive from the project path". */
    bank: z.string().min(1).nullable().optional(),
    recallTokens: z.number().int().min(1).optional(),
  }).strict().optional(),
  delegation: z.object({
    maxActive: z.number().int().min(1).optional(),
  }).strict().optional(),
  roles: z.object({
    overrides: z.record(z.string().min(1), roleRouteSchema).optional(),
  }).strict().optional(),
}).strict()

/** Values one layer may carry. */
export type ConfigLayer = z.infer<typeof configLayerSchema>

/** A role route override: which provider/model a named role uses in this project. */
export type RoleRoute = z.infer<typeof roleRouteSchema>

/** Partial update accepted by `write`; unlisted keys stay untouched. */
export type ProjectConfigPatch = ConfigLayer

/** The closed set of leaf fields a project may override. */
export const FIELD_PATHS = [
  'memory.enabled',
  'memory.bank',
  'memory.recallTokens',
  'delegation.maxActive',
  'roles.overrides',
] as const

/** One leaf field path. */
export type FieldPath = typeof FIELD_PATHS[number]

/** Renderer-facing field kind. */
export type FieldKind = 'boolean' | 'number' | 'string-or-null' | 'role-routes'

/** One row of the form a client derives. */
export interface FieldSpec {
  /** Dotted path inside the layer files. */
  readonly path: FieldPath
  /** Control the renderer should use. */
  readonly kind: FieldKind
  /** Plugin default, already resolved from profile-level `Config`. */
  readonly defaultValue: unknown
}

/** Resolved project identity plus every effective field. */
export interface ResolvedProjectConfig {
  /** Normalized absolute project root. */
  readonly root: string
  /** Display title: the root's basename. */
  readonly title: string
  /** Effective fields keyed by path. */
  readonly fields: Readonly<Record<FieldPath, ResolvedField<unknown>>>
}

/** One known project and which layers it uses. */
export interface ProjectConfigEntry {
  readonly root: string
  readonly title: string
  /** Whether `<root>/.omd/config.json` exists. */
  readonly repoConfig: boolean
  /** Whether the personal override layer names this root. */
  readonly userOverride: boolean
}

/** Plugin configuration: machine-wide defaults under the three project layers. */
export interface Config {
  /** Whether a project enables memory when neither layer says otherwise. */
  memoryEnabled: boolean
  /** Default bank name; the empty string means "derive from the project path". */
  memoryBank: string
  /** Default single-injection token cap. */
  memoryRecallTokens: number
  /** Default number of concurrently running subagents for our dispatcher. */
  delegationMaxActive: number
}

/** A layer error that names the file and the offending key. */
export class ProjectConfigFileError extends Error {
  override readonly name = 'ProjectConfigFileError'
  /** Absolute path of the malformed file. */
  readonly file: string

  /**
   * @param file - absolute path of the malformed file.
   * @param detail - what is wrong, e.g. `memory: Unrecognized key: "nope"`.
   */
  constructor(file: string, detail: string) {
    super(`project config: ${file}: ${detail}`)
    this.file = file
  }
}

/**
 * Validate one parsed layer object.
 * @param value - parsed JSON value.
 * @param file - absolute path used in diagnostics.
 * @returns the validated layer.
 * @throws {ProjectConfigFileError} naming the file and every invalid path.
 */
export function validateLayer(value: unknown, file: string): ConfigLayer {
  const result = configLayerSchema.safeParse(value)
  if (result.success) return result.data
  const detail = result.error.issues
    .map(issue => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
    .join('; ')
  throw new ProjectConfigFileError(file, detail)
}

/**
 * Build the default layer from profile-level plugin configuration.
 * @param config - validated plugin configuration.
 * @returns the lowest layer.
 */
export function defaultLayer(config: Config): ConfigLayer {
  return {
    memory: {
      enabled: config.memoryEnabled,
      bank: config.memoryBank === '' ? null : config.memoryBank,
      recallTokens: config.memoryRecallTokens,
    },
    delegation: { maxActive: config.delegationMaxActive },
    roles: { overrides: {} },
  }
}

/**
 * Read one leaf from a layer.
 * @param layer - validated layer.
 * @param path - dotted field path.
 * @returns the leaf value, or undefined when the layer does not name it.
 */
export function readField(layer: ConfigLayer | undefined, path: FieldPath): unknown {
  if (layer === undefined) return undefined
  const [section, key] = path.split('.') as [keyof ConfigLayer, string]
  const group = layer[section] as Record<string, unknown> | undefined
  if (group === undefined || !Object.hasOwn(group, key)) return undefined
  return group[key]
}

/**
 * Merge the three layers into effective fields with their source.
 * @param config - plugin configuration supplying defaults.
 * @param repo - repository layer, when the file exists.
 * @param user - personal override layer, when the root has one.
 * @returns effective values plus the form rows.
 */
export function resolveFields(
  config: Config,
  repo: ConfigLayer | undefined,
  user: ConfigLayer | undefined,
): { fields: Record<FieldPath, ResolvedField<unknown>>; schema: readonly FieldSpec[] } {
  const defaults = defaultLayer(config)
  const fields = {} as Record<FieldPath, ResolvedField<unknown>>
  const schema: FieldSpec[] = []
  for (const path of FIELD_PATHS) {
    const userValue = readField(user, path)
    const repoValue = readField(repo, path)
    const defaultValue = readField(defaults, path)
    const source: FieldSource = userValue !== undefined ? 'user' : repoValue !== undefined ? 'repo' : 'default'
    const value = userValue ?? repoValue ?? defaultValue
    fields[path] = { value, source }
    schema.push({ path, kind: kindOf(path), defaultValue })
  }
  return { fields, schema }
}

/**
 * Apply a partial patch on top of an existing layer, preserving keys the patch
 * does not name.
 * @param base - existing validated layer, or undefined for a fresh record.
 * @param patch - validated partial layer.
 * @returns a new layer object.
 */
export function mergeLayer(base: ConfigLayer | undefined, patch: ConfigLayer): ConfigLayer {
  const next: ConfigLayer = {
    ...base?.memory === undefined ? {} : { memory: { ...base.memory } },
    ...base?.delegation === undefined ? {} : { delegation: { ...base.delegation } },
    ...base?.roles === undefined ? {} : { roles: { ...base.roles } },
  }
  if (patch.memory !== undefined) next.memory = { ...next.memory, ...patch.memory }
  if (patch.delegation !== undefined) next.delegation = { ...next.delegation, ...patch.delegation }
  if (patch.roles !== undefined) {
    next.roles = {
      ...next.roles,
      ...patch.roles.overrides === undefined ? {} : { overrides: { ...patch.roles.overrides } },
    }
  }
  return next
}

/**
 * Delete one leaf (or the `roles.overrides` record) from a layer.
 * @param layer - layer to edit in place.
 * @param path - dotted field path.
 * @returns whether the layer changed.
 */
export function deleteField(layer: ConfigLayer, path: FieldPath): boolean {
  const [section, key] = path.split('.') as [keyof ConfigLayer, string]
  const group = layer[section] as Record<string, unknown> | undefined
  if (group === undefined || !Object.hasOwn(group, key)) return false
  delete group[key]
  if (Object.keys(group).length === 0) delete layer[section]
  return true
}

/**
 * Whether a layer names no field at all.
 * @param layer - layer to inspect.
 * @returns true when every section is absent.
 */
export function isEmptyLayer(layer: ConfigLayer): boolean {
  return Object.keys(layer).length === 0
}

/** Renderer kind for one path. */
function kindOf(path: FieldPath): FieldKind {
  switch (path) {
    case 'memory.enabled': return 'boolean'
    case 'memory.bank': return 'string-or-null'
    case 'memory.recallTokens': return 'number'
    case 'delegation.maxActive': return 'number'
    case 'roles.overrides': return 'role-routes'
  }
}
