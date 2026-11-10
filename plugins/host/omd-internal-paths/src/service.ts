/**
 * `ctx.internalPaths`: the one registry through which a data-owning plugin
 * publishes an addressable source, and through which the model side and the
 * web side read it.
 *
 * The service owns names, parsing, and the registered-source roster. It does
 * not own any source's content: a provider receives the path exactly as the
 * address carried it and returns text or bytes. Resolution is delegated to the
 * pure functions in `parse.ts`, so the same rules run in verification without
 * a Cordis context.
 *
 * The same instance is a Typert Remote namespace (`internalPaths`): the browser
 * half enumerates sources and reads addresses through it, so the interface has
 * no second syntax.
 *
 * @module omd-internal-paths/service
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseAddress, parseCanonical, parseShorthand, SOURCE_NAME, type AddressParts } from './parse.ts'
import { bindRemote, markRemoteMethods } from './remote.ts'

/** What a provider receives beside the path: the caller's cancellation, directory, and identity. */
export interface InternalExec {
  /** Aborted when the model-side call is cancelled. */
  readonly signal?: AbortSignal
  /** The calling session's working directory; project-bound sources resolve relative addresses against it. */
  readonly cwd?: string
  /** Mutation origin: 'model' (tool calls) or 'human' (UI). Defaults to 'model'. */
  readonly origin?: 'model' | 'human' | string
  /** Explicit target session id when called across sessions or from Remote. */
  readonly sessionId?: string
  /**
   * The calling agent. Layered services (skills, tools) take it as their scope
   * key — a read without it resolves the global layer alone, which is why a
   * skill a preset mounts reads as missing — and session-scoped sources take it
   * as the owner key. Absent for a call with no agent behind it, such as a
   * Remote read from the web UI.
   */
  readonly agent?: Agent
}

/** One registered data source. */
export interface InternalSource {
  /** The addresses this source accepts, for errors and documentation. */
  readonly grammar: string
  /** Human- and model-readable description of what this source contains. */
  readonly description?: string
  /** Accept `<source>://<path>` from the model side in addition to the canonical form. */
  readonly shorthand?: boolean
  /** The data changes while it is held; the web side may follow it. */
  readonly live?: boolean
  /** Whether this caller can discover or execute this source; omitted means shared. */
  available?(exec: InternalExec): boolean
  /** `read` returns bytes rather than text. */
  readonly binary?: boolean
  /**
   * Read one path owned by this source.
   * @param path - the address remainder, exactly as written.
   * @param exec - the calling execution, carrying cancellation.
   * @returns the source's content.
   */
  read(path: string, exec: InternalExec): Promise<string | Uint8Array>
  /**
   * Write one path owned by this source.
   * @param path - the address remainder within this source.
   * @param content - full text to write.
   * @param exec - the calling execution, carrying identity and origin.
   */
  write?(path: string, content: string, exec: InternalExec): Promise<string>
  /**
   * Edit one path owned by this source.
   * @param path - address remainder
   * @param oldString - literal text to find
   * @param newString - replacement text
   * @param replaceAll - whether all occurrences should be replaced
   * @param exec - execution context
   */
  edit?(path: string, oldString: string, newString: string, replaceAll: boolean, exec: InternalExec): Promise<string>
  /**
   * GET one address: fetch the representation behind it, when that differs
   * from reading its description. A source that omits this answers from
   * {@link read}, so a document source needs no separate implementation.
   * @param path - the address remainder.
   * @param exec - the calling execution, carrying cancellation.
   */
  get?(path: string, exec: InternalExec): Promise<string | Uint8Array>
  /**
   * POST one address: perform the action behind it, when that differs from
   * writing a document. Omitted means {@link write} answers instead.
   * @param path - the address remainder.
   * @param content - the request body.
   * @param exec - the calling execution, carrying identity and cancellation.
   */
  post?(path: string, content: string, exec: InternalExec): Promise<string>
  /**
   * Watch one address: push a line whenever the thing behind it changes.
   * A source that cannot push omits this, and the caller is told so instead of
   * being handed a poller that pretends to be a subscription.
   * @param path - the address remainder.
   * @param exec - the calling execution; aborting it ends the stream.
   */
  watch?(path: string, exec: InternalExec): AsyncIterable<string>
}

/** One path permission rule enforced by the registry backend. */
export interface PathPermissionRule {
  /** Target agent name, session id, or '*' for all. */
  readonly agent?: string
  /** Path prefix or pattern (e.g. "dsh-resource://notebook", "notebook://", or exact address). */
  readonly path: string
  /** Actions this rule applies to: 'read' | 'write' | 'edit' | '*'. */
  readonly action?: 'read' | 'write' | 'edit' | '*'
  /** Access decision: 'allow' | 'deny' | 'read-only'. */
  readonly access?: 'allow' | 'deny' | 'read-only'
}

/** The roster entry the web side and error messages use. */
export interface InternalSourceInfo {
  /** Registered source name. */
  readonly source: string
  /** Accepted address forms. */
  readonly grammar: string
  /** Human- and model-readable description. */
  readonly description?: string
  /** Whether writes are supported by this source. */
  readonly writable: boolean
  /** Whether the shorthand form is accepted for this source. */
  readonly shorthand: boolean
  /** Whether reads describe live data. */
  readonly live: boolean
}

/** One address resolved to the provider that owns it. */
export interface ResolvedInternalPath extends AddressParts {
  /** The registered provider. */
  readonly provider: InternalSource
}

/** The service published as `ctx.internalPaths`. */
export interface InternalPathsService {
  /**
   * Register one source for the caller's lifetime.
   * @param source - lowercase source name, unique in the process.
   * @param provider - the source's reader and its declared traits.
   * @returns an idempotent disposer that removes this registration.
   * @throws when the name is invalid or already registered.
   */
  register(source: string, provider: InternalSource): () => void
  /**
   * Check permissions for an action on an internal path, throwing on denial.
   * @param address - target internal address.
   * @param action - 'read' | 'write' | 'edit'.
   * @param exec - execution context.
   */
  checkPermission(address: string, action: 'read' | 'write' | 'edit', exec: InternalExec): void
  /**
   * Register a backend permission rule.
   * @param rule - permission rule to enforce.
   * @returns unregister disposer.
   */
  setPermission(rule: PathPermissionRule): () => void
  /** Sources available to this execution, sorted by name; no execution lists the browser protocols. */
  sources(exec?: InternalExec): InternalSourceInfo[]
  /**
   * Resolve an address against the registry.
   * @param address - canonical or shorthand form.
   * @returns the owning provider, or undefined when the address names no registered source.
   */
  resolve(address: string): ResolvedInternalPath | undefined
  /**
   * Read one address.
   * @param address - canonical or shorthand form.
   * @param exec - the calling execution, carrying cancellation.
   * @returns the source's content.
   * @throws when no registered source owns the address.
   */
  read(address: string, exec: InternalExec): Promise<string | Uint8Array>
  /**
   * Write one address.
   * @param address - canonical or shorthand form.
   * @param content - the content to write.
   * @param exec - the calling execution, carrying cancellation and identity.
   * @returns the write outcome.
   * @throws when no source owns the address, or when the source is read-only.
   */
  write(address: string, content: string, exec: InternalExec): Promise<string>
  /**
   * Remote endpoint for writing.
   * @param address - target address.
   * @param content - content to write.
   * @param sessionId - optional session id.
   * @param origin - optional origin ('human' | 'model').
   * @param signal - optional cancellation signal.
   */
  writeRemote(address: string, content: string, sessionId?: string, origin?: string, signal?: AbortSignal): Promise<string>
  /**
   * Edit an internal address by literal text replacement.
   * @param address - target internal address
   * @param oldString - literal text to find
   * @param newString - replacement text
   * @param replaceAll - replace all occurrences vs single match
   * @param exec - execution context
   */
  edit(address: string, oldString: string, newString: string, replaceAll: boolean, exec: InternalExec): Promise<string>
  /**
   * GET one address: the source's own representation, or its document read
   * when the source declares no separate one.
   * @param address - canonical or shorthand form.
   * @param exec - the calling execution, carrying cancellation.
   */
  fetch(address: string, exec: InternalExec): Promise<string | Uint8Array>
  /**
   * POST one address: the source's own action, or its document write when the
   * source declares no separate one.
   * @param address - canonical or shorthand form.
   * @param content - the request body.
   * @param exec - the calling execution, carrying identity and cancellation.
   */
  submit(address: string, content: string, exec: InternalExec): Promise<string>
  /**
   * Watch one address for pushed changes.
   * @param address - canonical or shorthand form.
   * @param exec - the calling execution; aborting its signal ends the stream.
   * @throws when the source cannot push, naming the address.
   */
  stream(address: string, exec: InternalExec): AsyncIterable<string>
}

/**
 * The live registry. One instance per host; published by the plugin body.
 */
export class InternalPathsServiceImpl implements InternalPathsService {
  readonly #sources = new Map<string, InternalSource>()
  readonly #permissions: PathPermissionRule[] = []

  constructor() {
    bindRemote(this, 'internalPaths', 'internalPaths')
  }

  register(source: string, provider: InternalSource): () => void {
    if (!SOURCE_NAME.test(source)) {
      throw new Error(`internal source ${JSON.stringify(source)} must be lowercase letters, digits, or "-"`)
    }
    if (typeof provider.grammar !== 'string' || provider.grammar.trim() === '') {
      throw new Error(`internal source ${JSON.stringify(source)} must declare its grammar`)
    }
    let description = provider.description
    if (typeof description !== 'string' || description.trim() === '') {
      if (source === 'skill') {
        description = 'Described skills mounted in the calling agent scope'
      } else {
        throw new Error(`internal source ${JSON.stringify(source)} must declare a description`)
      }
    }
    const effectiveProvider = description === provider.description ? provider : { ...provider, description }
    const existing = this.#sources.get(source)
    if (existing !== undefined) {
      throw new Error(`internal source ${JSON.stringify(source)} is already registered (${existing.grammar})`)
    }
    this.#sources.set(source, effectiveProvider)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#sources.get(source) === effectiveProvider) this.#sources.delete(source)
    }
  }

  setPermission(rule: PathPermissionRule): () => void {
    this.#permissions.push(rule)
    return () => {
      const index = this.#permissions.indexOf(rule)
      if (index !== -1) this.#permissions.splice(index, 1)
    }
  }

  checkPermission(address: string, action: 'read' | 'write' | 'edit', exec: InternalExec): void {
    if (this.resolve(address)?.provider.available?.(exec) === false) {
      throw new Error(`permission denied: source is not available in this session`)
    }
    const agent = exec.agent
    const agentName = agent?.name ?? (agent as { id?: string } | undefined)?.id ?? exec.sessionId
    for (const rule of this.#permissions) {
      if (rule.agent && rule.agent !== '*' && rule.agent !== agentName && rule.agent !== exec.sessionId) {
        continue
      }
      const target = rule.path.endsWith('*') ? rule.path.slice(0, -1) : rule.path
      const matchesPath = address === rule.path || address.startsWith(target)
      if (!matchesPath) continue
      const matchesAction = !rule.action || rule.action === '*' || rule.action === action
      if (!matchesAction) continue
      if (rule.access === 'deny' || (rule.access === 'read-only' && action !== 'read')) {
        throw new Error(`permission denied: agent ${JSON.stringify(agentName ?? 'anonymous')} cannot ${action} "${address}"`)
      }
    }
  }

  sources(exec?: InternalExec): InternalSourceInfo[] {
    return [...this.#sources]
      .filter(([, provider]) => exec === undefined || provider.available?.(exec) !== false)
      .map(([source, provider]) => ({
        source,
        grammar: provider.grammar,
        description: provider.description,
        writable: typeof provider.write === 'function',
        shorthand: provider.shorthand === true,
        live: provider.live === true,
      }))
      .sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : 0)
  }

  resolve(address: string): ResolvedInternalPath | undefined {
    const parts = parseAddress(address, source => this.#sources.get(source)?.shorthand === true)
    if (parts === undefined) return undefined
    const provider = this.#sources.get(parts.source)
    if (provider === undefined) return undefined
    return { ...parts, provider }
  }

  async read(address: string, exec: InternalExec): Promise<string | Uint8Array> {
    const parts = parseCanonical(address)
    if (parts !== undefined && parts.source === '') {
      return this.describeRoot(exec)
    }
    this.checkPermission(address, 'read', exec)
    const resolved = this.resolve(address)
    if (resolved !== undefined) {
      return await resolved.provider.read(resolved.path, exec)
    }
    throw new Error(describeMiss(address, this.sources(exec)))
  }

  /**
   * The Remote endpoint behind `internalPaths.read(address)`. Separate from
   * {@link read} because the wire call has no execution to carry: the
   * carrier's cancellation signal becomes the provider's signal.
   * @param address - canonical internal address.
   * @param signal - injected by the Gateway; final parameter marks cancellation.
   * @returns the source's content.
   */
  async readRemote(address: string, signal?: AbortSignal): Promise<string | Uint8Array> {
    return await this.read(address, { signal })
  }

  async write(address: string, content: string, exec: InternalExec): Promise<string> {
    const parts = parseCanonical(address)
    if (parts !== undefined && parts.source === '') {
      throw new Error('cannot write to "dsh-resource://": root resource registry is read-only')
    }
    this.checkPermission(address, 'write', exec)
    const resolved = this.resolve(address)
    if (resolved === undefined) {
      throw new Error(describeMiss(address, this.sources(exec)))
    }
    if (typeof resolved.provider.write !== 'function') {
      throw new Error(`cannot write to "${address}": source ${JSON.stringify(resolved.source)} is read-only`)
    }
    return await resolved.provider.write(resolved.path, content, exec)
  }

  async fetch(address: string, exec: InternalExec): Promise<string | Uint8Array> {
    this.checkPermission(address, 'read', exec)
    const resolved = this.resolve(address)
    if (resolved === undefined) {
      throw new Error(describeMiss(address, this.sources(exec)))
    }
    if (typeof resolved.provider.get === 'function') {
      return await resolved.provider.get(resolved.path, exec)
    }
    return await resolved.provider.read(resolved.path, exec)
  }

  async submit(address: string, content: string, exec: InternalExec): Promise<string> {
    this.checkPermission(address, 'write', exec)
    const resolved = this.resolve(address)
    if (resolved === undefined) {
      throw new Error(describeMiss(address, this.sources(exec)))
    }
    if (typeof resolved.provider.post === 'function') {
      return await resolved.provider.post(resolved.path, content, exec)
    }
    if (typeof resolved.provider.write !== 'function') {
      throw new Error(`cannot POST to "${address}": source ${JSON.stringify(resolved.source)} declares no action`)
    }
    return await resolved.provider.write(resolved.path, content, exec)
  }

  stream(address: string, exec: InternalExec): AsyncIterable<string> {
    this.checkPermission(address, 'read', exec)
    const resolved = this.resolve(address)
    if (resolved === undefined) {
      throw new Error(describeMiss(address, this.sources(exec)))
    }
    if (typeof resolved.provider.watch !== 'function') {
      throw new Error(`${JSON.stringify(resolved.source)} cannot push: ${JSON.stringify(address)} has no change stream`)
    }
    return resolved.provider.watch(resolved.path, exec)
  }

  async writeRemote(address: string, content: string, sessionId?: string, origin = 'human', signal?: AbortSignal): Promise<string> {
    return await this.write(address, content, {
      signal,
      origin,
      sessionId,
    })
  }

  async edit(address: string, oldString: string, newString: string, replaceAll: boolean, exec: InternalExec): Promise<string> {
    const parts = parseCanonical(address)
    if (parts !== undefined && parts.source === '') {
      throw new Error('cannot edit "dsh-resource://": root resource registry is read-only')
    }
    this.checkPermission(address, 'edit', exec)
    const resolved = this.resolve(address)
    if (resolved === undefined) {
      throw new Error(describeMiss(address, this.sources(exec)))
    }
    if (typeof resolved.provider.edit === 'function') {
      return await resolved.provider.edit(resolved.path, oldString, newString, replaceAll, exec)
    }
    if (typeof resolved.provider.write !== 'function') {
      throw new Error(`cannot edit "${address}": source ${JSON.stringify(resolved.source)} is read-only`)
    }
    const current = await this.read(address, exec)
    if (typeof current !== 'string') {
      throw new Error(`cannot edit "${address}": source returned binary data`)
    }
    const updated = performTextEdit(current, oldString, newString, replaceAll)
    await resolved.provider.write(resolved.path, updated, exec)
    return replaceAll
      ? `Successfully replaced all occurrences of text in "${address}".`
      : `Successfully replaced text in "${address}".`
  }

  private describeRoot(exec: InternalExec): string {
    const list = this.sources(exec)
    if (list.length === 0) {
      return '# Internal Path Sources\n\nNo internal sources registered.'
    }
    const lines = [
      '# Internal Path Sources',
      '',
      'The following internal resource sources are registered and addressable via `dsh-resource://<source>/<path>`:',
      '',
    ]
    for (const s of list) {
      const caps = [s.writable ? 'writable' : 'read-only', s.live ? 'live' : undefined].filter(Boolean).join(', ')
      lines.push(`- **${s.source}** (${caps}): ${s.description ?? s.grammar}`)
      lines.push(`  Grammar: \`${s.grammar}\``)
    }
    return lines.join('\n')
  }

  private describeSource(name: string, provider: InternalSource): string {
    const caps = [typeof provider.write === 'function' ? 'writable' : 'read-only', provider.live ? 'live' : undefined].filter(Boolean).join(', ')
    return [
      `# Source: ${name} (${caps})`,
      '',
      provider.description ?? `Internal source for ${name}.`,
      `Grammar: \`${provider.grammar}\``,
    ].join('\n')
  }

  /** Drop every registration; called when the plugin's fiber unloads. */
  dispose(): void {
    this.#sources.clear()
  }
}

/**
 * Why an address did not resolve, with the roster that would have.
 * @param address - the rejected address.
 * @param sources - the current roster.
 * @returns one sentence naming the closest failing rule.
 */
function describeMiss(address: string, sources: readonly InternalSourceInfo[]): string {
  const roster = sources.length === 0
    ? 'no internal sources are registered'
    : `registered: ${sources.map(source => `${source.source} (${source.grammar})`).join('; ')}`
  const canonical = parseCanonical(address)
  if (canonical !== undefined) {
    return `cannot read "${address}": no internal source ${JSON.stringify(canonical.source)} (${roster})`
  }
  const shorthand = parseShorthand(address)
  if (shorthand !== undefined) {
    return `cannot read "${address}": ${JSON.stringify(`${shorthand.source}://`)} shorthand is only accepted by sources that declare it (${roster})`
  }
  return `cannot read "${address}": not an internal path — write "dsh-resource://<source>/<path>" (${roster})`
}

markRemoteMethods(InternalPathsServiceImpl.prototype, [
  'sources',
  { method: 'readRemote', exportName: 'read' },
  { method: 'writeRemote', exportName: 'write' },
])

/**
 * Deterministic literal string replacement.
 * @param content - text before replacement
 * @param oldString - literal string to replace
 * @param newString - replacement text
 * @param replaceAll - replace all occurrences vs single match
 * @returns updated text
 */
export function performTextEdit(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString.length === 0) throw new Error('old_string must be a non-empty string')
  if (oldString === newString) throw new Error('old_string and new_string must differ')
  const firstIdx = content.indexOf(oldString)
  if (firstIdx === -1) throw new Error('old_string not found in content')
  if (!replaceAll) {
    const secondIdx = content.indexOf(oldString, firstIdx + oldString.length)
    if (secondIdx !== -1) throw new Error('old_string found multiple times; must appear exactly once or set replace_all: true')
    return content.slice(0, firstIdx) + newString + content.slice(firstIdx + oldString.length)
  }
  return content.replaceAll(oldString, newString)
}
