/**
 * Host-side project configuration service: three-layer resolution, personal
 * overrides persisted in a `ctx.storageDomain` record set, and the change
 * notifications consumers subscribe to.
 *
 * The personal layer is keyed by the canonical project root. Every entry point
 * takes a `cwd` (or a root already returned by this service) and runs the same
 * git-based root resolution, so a panel anchored on a Workspace path and a
 * consumer anchored on `ctx.workingDirectory.get(session)` read one merged
 * configuration.
 *
 * @module omd-project-config/service
 */

import {
  configLayerSchema,
  deleteField,
  FIELD_PATHS,
  isEmptyLayer,
  mergeLayer,
  resolveFields,
  type Config,
  type ConfigLayer,
  type FieldPath,
  type FieldSpec,
  type ProjectConfigEntry,
  type ProjectConfigPatch,
  type ResolvedProjectConfig,
} from './schema.ts'
import { bindRemote, markRemoteMethods } from './remote.ts'
import { knownProjectRoots, projectRoot, readRepoLayer, titleOf } from './store.ts'

/** One table handle of an open storage domain. */
interface DomainTable<T> {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

/** The open handle this service keeps. */
interface OpenDomain {
  table(name: 'overrides'): DomainTable<ConfigLayer>
  close(): Promise<void>
}

/** The part of `ctx.storageDomain` this plugin uses. */
export interface DomainFacility {
  open(spec: {
    readonly name: string
    readonly version: number
    readonly tables: { readonly overrides: { readonly valueSchema: unknown } }
  }): Promise<OpenDomain>
}

/**
 * Declared storage domain. Constructed as plain data rather than with
 * `defineDomain` because the storage-domain package is not part of the host
 * runtime a plugin can import; the facility consumes this exact shape. The
 * name follows the storage unit grammar (`[a-z][a-z0-9_]*`), which excludes
 * the package name's hyphens.
 */
const projectConfigDomain = {
  name: 'omd_project_config',
  version: 1,
  tables: { overrides: { valueSchema: configLayerSchema } },
}

/** One notification after a personal-layer write. */
export interface ProjectConfigChange {
  readonly root: string
  readonly config: ResolvedProjectConfig
}

/** Consumer callback registered through {@link ProjectConfigService.subscribe}. */
export type ProjectConfigListener = (change: ProjectConfigChange) => void

/** Public face published as `ctx.projectConfig`. */
export interface ProjectConfigService {
  /** Form rows every renderer derives from; defaults already applied. */
  schema(): readonly FieldSpec[]
  /** Resolve the composite for a working directory (or any directory inside the project). */
  resolve(cwd: string): Promise<ResolvedProjectConfig>
  /** Every project this process has seen, with its layer usage. */
  list(): Promise<ProjectConfigEntry[]>
  /** Raw validated layers for one root; absent keys mean the layer is missing. */
  layers(root: string): Promise<{ repo?: ConfigLayer; user?: ConfigLayer }>
  /** Merge a partial patch into the personal layer and return the new composite. */
  write(root: string, patch: ProjectConfigPatch): Promise<ResolvedProjectConfig>
  /** Remove one field (or the whole personal layer) for this root. */
  clear(root: string, path?: string): Promise<ResolvedProjectConfig>
  /** Observe personal-layer changes made through this service. */
  subscribe(listener: ProjectConfigListener): () => void
}

/** Methods exposed on the `projectConfig` Remote namespace, in declaration order. */
const REMOTE_METHODS = ['schema', 'resolve', 'list', 'layers', 'write', 'clear'] as const

/**
 * The live service. Constructed once by the plugin body and published with
 * `ctx.provide('projectConfig', service)`.
 */
export class ProjectConfigServiceImpl implements ProjectConfigService {
  private readonly config: Config
  private readonly ready: Promise<OpenDomain>
  private readonly listeners = new Set<ProjectConfigListener>()

  /**
   * @param storage - the host's domain facility.
   * @param config - validated plugin defaults.
   */
  constructor(storage: DomainFacility, config: Config) {
    this.config = config
    this.ready = storage.open(projectConfigDomain)
    bindRemote(this, 'projectConfig', 'projectConfig')
  }

  schema(): readonly FieldSpec[] {
    return resolveFields(this.config, undefined, undefined).schema
  }

  async resolve(cwd: string): Promise<ResolvedProjectConfig> {
    return this.resolveRoot(await projectRoot(cwd))
  }

  async list(): Promise<ProjectConfigEntry[]> {
    const domain = await this.ready
    const table = domain.table('overrides')
    const roots = new Set<string>(table.keys())
    for (const root of knownProjectRoots()) roots.add(root)
    const entries: ProjectConfigEntry[] = []
    for (const root of [...roots].sort()) {
      entries.push({
        root,
        title: titleOf(root),
        repoConfig: await readRepoLayer(root) !== undefined,
        userOverride: table.get(root) !== undefined,
      })
    }
    return entries
  }

  async layers(root: string): Promise<{ repo?: ConfigLayer; user?: ConfigLayer }> {
    const domain = await this.ready
    const repo = await readRepoLayer(root)
    const user = domain.table('overrides').get(root)
    return {
      ...repo === undefined ? {} : { repo },
      ...user === undefined ? {} : { user },
    }
  }

  async write(root: string, patch: ProjectConfigPatch): Promise<ResolvedProjectConfig> {
    const parsed = configLayerSchema.safeParse(patch)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(issue => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      throw new Error(`project config patch: ${detail}`)
    }
    const domain = await this.ready
    const table = domain.table('overrides')
    const next = mergeLayer(table.get(root), parsed.data)
    await table.put(root, next)
    const config = await this.composite(root)
    this.notify({ root, config })
    return config
  }

  async clear(root: string, path?: string): Promise<ResolvedProjectConfig> {
    if (path !== undefined && !isFieldPath(path)) {
      throw new Error(`project config: unknown field ${JSON.stringify(path)}`)
    }
    const domain = await this.ready
    const table = domain.table('overrides')
    const existing = table.get(root)
    if (existing !== undefined) {
      if (path === undefined) {
        await table.delete(root)
      } else {
        const next: ConfigLayer = structuredClone(existing)
        if (deleteField(next, path) && !isEmptyLayer(next)) await table.put(root, next)
        else await table.delete(root)
      }
    }
    const config = await this.composite(root)
    this.notify({ root, config })
    return config
  }

  subscribe(listener: ProjectConfigListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Close the storage domain; called from the plugin's effect disposer. */
  async dispose(): Promise<void> {
    this.listeners.clear()
    try {
      await (await this.ready).close()
    } catch {
      // A failed open has nothing to close; an already-closed domain is idempotent.
    }
  }

  private async resolveRoot(root: string): Promise<ResolvedProjectConfig> {
    return this.composite(root)
  }

  private async composite(root: string): Promise<ResolvedProjectConfig> {
    const domain = await this.ready
    const user = domain.table('overrides').get(root)
    const { fields } = resolveFields(this.config, await readRepoLayer(root), user)
    return { root, title: titleOf(root), fields }
  }

  private notify(change: ProjectConfigChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A consumer's failure must not undo a durable write or stop other consumers.
      }
    }
  }
}

function isFieldPath(value: string): value is FieldPath {
  return (FIELD_PATHS as readonly string[]).includes(value)
}

markRemoteMethods(ProjectConfigServiceImpl.prototype, REMOTE_METHODS)
