/**
 * Navigation tools over the language-server client that `dsh-tool-lsp` runs.
 *
 * `dsh-tool-lsp` publishes no service — its sessions live in the closure of its
 * own `apply`, and all it hands out are five tools (`lsp_diagnostics`,
 * `lsp_format`, `lsp_rename`, `lsp_code_action`, `lsp_symbols`). Definition,
 * type definition, implementation, references and hover are missing, and adding
 * them needs its client, not its tools.
 *
 * **Coupling point and its upgrade risk.** This package imports the community
 * client's internal modules directly, declared in `./dsh-tool-lsp.d.ts`:
 *
 *   - `lib/servers.js` — `resolveServers`: the configured table → runnable entries.
 *   - `lib/executor.js` — `openForCall` / `resolveRoot`: workspace root, server
 *     routing, file read, document open.
 *   - `lib/runner.js` — `LspSession`, the client itself.
 *   - `lib/translate.js` — position decoding and location normalization.
 *   - `lib/render.js` — workspace-relative path display.
 *   - `lib/patch-config.js` — the patch layer `dsh-tool-lsp` itself reads.
 *
 * Those are internal modules, not the public entry point. An upgrade that
 * renames or moves them breaks the imports in this file; the declarations in
 * `./dsh-tool-lsp.d.ts` are the whole surface relied on, so the failure is a
 * type error at build time or an import error at mount time — never a silently
 * wrong answer at call time.
 *
 * **Processes.** All five tools share one `LspSession` per server id, started
 * lazily and reused for every later call, so a navigation call costs one cold
 * start per language server and nothing after that. That table belongs to this
 * plugin instance and is disposed on unmount, exactly as `dsh-tool-lsp` does
 * with its own.
 *
 * The community client keeps its table private, so with both packages mounted a
 * language server can be started once by each: two `tsserver` processes for one
 * workspace. There is no way around that from here — the table is not reachable
 * through a service, a symbol, or a closure — so it is recorded rather than
 * hidden. Closing it is a decision above this package: either the community
 * client publishes its table (or an `lsp` service) for a consumer to adopt, or
 * the profile mounts only one LSP surface. This deployment has no `lsp` service
 * in dsh core (`@deepseek-ai/dsh` 0.2.1-rc.2 ships none).
 *
 * @module omd-lsp-nav
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveServers } from 'dsh-tool-lsp/lib/servers.js'
import type { ResolvedServer } from 'dsh-tool-lsp/lib/servers.js'
import { openForCall, resolveRoot } from 'dsh-tool-lsp/lib/executor.js'
import { LspSession } from 'dsh-tool-lsp/lib/runner.js'
import { normalizeLocation } from 'dsh-tool-lsp/lib/translate.js'
import { displayPath } from 'dsh-tool-lsp/lib/render.js'
import { loadPatchLayerLspConfig } from 'dsh-tool-lsp/lib/patch-config.js'
import { LSP_ERROR, lspError } from 'dsh-tool-lsp/lib/vocabulary.js'

/** The plugin's registration name. */
export const name = 'omd-lsp-nav'

/**
 * Services this plugin needs: the tool registry, plus the two seams the client
 * is built on. `dsh-tool-lsp` requires the same pair, so any profile that can
 * run it can run this package.
 */
export const inject = ['tools', 'fs', 'subprocess']

/** What the plugin accepts from its patch row. */
export interface Config {
  /**
   * Server table, in the same shape `dsh-tool-lsp` takes. Empty means "read the
   * profile's patch layer", so one `servers:` block configures both packages.
   */
  servers: Record<string, unknown>
  /** Per-request budget handed to the client, in milliseconds. */
  timeoutMs: number
  /** Largest document the client reads whole for one navigation call. */
  maxDocumentBytes: number
}

/** Configuration schema; every key has a default so an empty row mounts. */
export const Config: z<Config> = z.object({
  servers: z.dict(z.any()).default({}),
  timeoutMs: z.number().step(1).min(1).default(60000)
    .description('Per-request budget handed to the language-server client, in milliseconds.'),
  maxDocumentBytes: z.number().step(1).min(1).default(8 * 1024 * 1024)
    .description('Largest document the client reads whole for one navigation call, in bytes.'),
})

/** A position in the convention the client speaks internally. */
interface WirePosition {
  readonly line: number
  readonly character: number
}

/** The workspace root, as both a path and a `file:` URI. */
interface WorkspaceRoot {
  readonly path: string
  readonly uri: string
}

/** The `sessionFor` seam `openForCall` calls to start or reuse one server. */
type SessionFor = (
  server: ResolvedServer,
  root: WorkspaceRoot,
  signal: AbortSignal | undefined,
) => Promise<LspSession>

/**
 * The per-call context `openForCall` reads.
 *
 * Written structurally so the coupling is legible: these are the fields
 * `dsh-tool-lsp/lib/executor.js` touches by name.
 */
interface CallContext {
  readonly fs: unknown
  readonly servers: readonly ResolvedServer[]
  readonly sessions: Map<string, LspSession>
  readonly rootFor: (exec: unknown, signal: AbortSignal | undefined) => Promise<WorkspaceRoot>
  readonly sessionFor: SessionFor
  readonly maxDocumentBytes: number
}

/** A location as the navigation tools report it. */
interface NavLocation {
  file: string
  line: number
  character: number
}

/** The one-based position parameters every navigation tool declares. */
const POSITION_PARAMS = {
  file: {
    type: 'string' as const,
    required: true as const,
    description:
      'Source file to act on: a workspace-relative or absolute path. Pass a file that exists; this tool does not create one.',
  },
  line: {
    type: 'integer' as const,
    required: true as const,
    description: 'One-based line number, the coordinate system `read` prints. Line 1 is the first line.',
  },
  character: {
    type: 'integer' as const,
    required: true as const,
    description:
      'One-based UTF-16 column within the line. Column 1 is the first character; an editor cursor position maps directly.',
  },
}

/**
 * The shared result schema of the four location-returning tools.
 *
 * `locations` is always present: an empty array means the server answered "no
 * result", which the render and the metadata both report as a clean miss.
 */
const LOCATIONS_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    locations: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          file: { type: 'string' as const, required: true as const },
          line: { type: 'integer' as const, required: true as const },
          character: { type: 'integer' as const, required: true as const },
        },
      },
    },
  },
}

/**
 * Read the calling agent's validated `cwd` off an execution.
 *
 * `exec.agent` is optional (a call with no agent behind it) and `cwd` lives in
 * the session header, so the chain is narrowed rather than asserted. A session
 * without a usable `cwd` falls back to the process directory, the same choice
 * `dsh-tool-lsp` makes.
 *
 * @param exec - the tool execution.
 * @returns the directory the call resolves against.
 */
function callCwd(exec: unknown): string {
  if (exec === null || typeof exec !== 'object' || !('agent' in exec)) return process.cwd()
  const agent = exec.agent
  if (agent === null || typeof agent !== 'object' || !('session' in agent)) return process.cwd()
  const session = agent.session
  if (session === null || typeof session !== 'object' || !('header' in session)) return process.cwd()
  const header = session.header
  if (header === null || typeof header !== 'object' || !('cwd' in header)) return process.cwd()
  return typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : process.cwd()
}

/**
 * Mount the navigation tool surface.
 *
 * Everything that can fail at load fails here, before a tool is registered: the
 * server table is resolved through the same subprocess seam the client uses, so
 * a bad command is a mount error rather than a surprise on the model's first
 * call.
 *
 * @param ctx - the host context, which supplies `fs` and `subprocess`.
 * @param config - the resolved plugin configuration.
 * @returns a promise that settles once the five tools are registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('omd-lsp-nav: requires the dsh fs service')
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('omd-lsp-nav: requires the dsh subprocess service')

  let serverTable = config.servers
  if (serverTable === null || Object.keys(serverTable).length === 0) {
    const fromPatch = loadPatchLayerLspConfig()
    if (fromPatch?.servers != null && Object.keys(fromPatch.servers).length > 0) {
      serverTable = fromPatch.servers
    }
  }

  const servers = await resolveServers({ subprocess }, serverTable)

  /** Live sessions per server id, shared by all five tools. */
  const sessions = new Map<string, LspSession>()

  /** Resolve each workspace root once; a session is keyed to the first one. */
  const rootCache = new Map<string, Promise<WorkspaceRoot>>()
  const rootFor = async (exec: unknown, signal: AbortSignal | undefined): Promise<WorkspaceRoot> => {
    const key = callCwd(exec)
    let root = rootCache.get(key)
    if (root === undefined) {
      root = resolveRoot(fs, key, signal)
      rootCache.set(key, root)
    }
    return root
  }

  /** Get (or lazily start) the session for one configured entry. */
  const sessionFor: SessionFor = async (server, root, signal) => {
    let session = sessions.get(server.serverId)
    if (session === undefined) {
      session = new LspSession(
        {
          serverId: server.serverId,
          command: server.executable,
          args: server.entry.args,
          cwd: root.path,
          env: server.entry.env,
          initializationOptions: server.entry.initializationOptions,
          configuration: server.entry.configuration,
          maxMessageBytes: server.entry.maxMessageBytes,
          maxStderrBytes: server.entry.maxStderrBytes,
          killGraceMs: server.entry.killGraceMs,
          shutdownTimeoutMs: server.entry.shutdownTimeoutMs,
        },
        // Bound, not wrapped: the request's shape belongs to the subprocess
        // service, so it is passed through untouched.
        subprocess.spawn.bind(subprocess),
        root.uri,
        config.timeoutMs,
      )
      sessions.set(server.serverId, session)
    }
    await session.start(signal)
    return session
  }

  const callContext: CallContext = {
    fs,
    servers,
    sessions,
    rootFor,
    sessionFor,
    // Hover and reference lookups never need a generous document budget, and
    // the client refuses oversized files rather than reading them whole.
    maxDocumentBytes: config.maxDocumentBytes,
  }

  /**
   * Refuse a request the server never advertised, instead of letting the wire
   * answer with `-32601` and the model read a transport error.
   *
   * @param session - the live session.
   * @param serverId - the entry's id, for the message.
   * @param capabilityPath - the `ServerCapabilities` key, e.g. `hoverProvider`.
   * @param method - the request method, for the message.
   * @throws `LSP_UNSUPPORTED` when the capability is absent or `false`.
   */
  function requireCapability(session: LspSession, serverId: string, capabilityPath: string, method: string): void {
    const advertised = session.capability(capabilityPath)
    if (advertised === undefined || advertised === false) {
      throw lspError(LSP_ERROR.UNSUPPORTED, `${serverId} does not support ${method}`)
    }
  }

  /**
   * Map one raw server location into the published shape.
   *
   * `normalizeLocation` decodes the server's position encoding and its `start`
   * is already one-based, so no second shift happens here.
   *
   * @param value - one entry from the server's location answer.
   * @param decode - the session's wire → zero-based UTF-16 converter.
   * @param rootPath - the workspace root, for a relative display path.
   * @returns the published location.
   */
  function toNavLocation(
    value: unknown,
    decode: (position: WirePosition) => WirePosition,
    rootPath: string,
  ): NavLocation {
    const normalized = normalizeLocation(value, decode)
    return {
      file: displayPath(normalized.file_path, rootPath),
      line: normalized.start.line,
      character: normalized.start.character,
    }
  }

  /**
   * Build one location-returning navigation tool.
   *
   * @param toolName - the model-facing tool name.
   * @param description - the model-facing description.
   * @param capabilityPath - the capability the server must advertise.
   * @param method - the LSP request method.
   * @param buildParams - protocol params for one document position.
   * @returns the tool definition.
   */
  function locationTool(
    toolName: string,
    description: string,
    capabilityPath: string,
    method: string,
    buildParams: (uri: string, position: WirePosition) => unknown,
  ) {
    return defineTool({
      name: toolName,
      description,
      parameters: POSITION_PARAMS,
      output: {
        schema: LOCATIONS_SCHEMA,
        render: (args, value) =>
          value.locations.length === 0
            ? [{ type: 'text', text: `No results at ${args.file}:${args.line}:${args.character}` }]
            : [
                {
                  type: 'text',
                  text: value.locations.map((location) => `${location.file}:${location.line}:${location.character}`).join('\n'),
                },
              ],
        presentationMeta: (_args, value) => (value.locations.length === 0 ? { useless: true } : {}),
      },
      async execute(args, exec) {
        const opened = await openForCall(callContext, args.file, exec)
        const { session, document, uri } = opened
        requireCapability(session, opened.serverId, capabilityPath, method)
        const decode = document.decoder(session.encoding)
        const position = document.toWire(args.line, args.character, session.encoding)
        const payload = await session.request(method, buildParams(uri, position), exec.signal)
        // A definition answer is one Location, an array of them, or null; an
        // array of LocationLink goes through the same normalizer.
        const entries = payload === null || payload === undefined ? [] : Array.isArray(payload) ? payload : [payload]
        return { locations: entries.map((entry) => toNavLocation(entry, decode, opened.root.path)) }
      },
    })
  }

  /** Params for the requests that take only a document position. */
  const positionParams = (uri: string, position: WirePosition) => ({ textDocument: { uri }, position })

  ctx.tools.register(
    locationTool(
      'lsp_definition',
      'Where the symbol at a position is defined. Read-only. Use it instead of searching by name when you need the source of a function, type or constant.',
      'definitionProvider',
      'textDocument/definition',
      positionParams,
    ),
  )

  ctx.tools.register(
    locationTool(
      'lsp_type_definition',
      'Where the TYPE of the expression at a position is defined — the class or interface behind a value, not the value itself. Read-only.',
      'typeDefinitionProvider',
      'textDocument/typeDefinition',
      positionParams,
    ),
  )

  ctx.tools.register(
    locationTool(
      'lsp_implementation',
      'Concrete implementations of the interface or abstract member at a position. Read-only. Use it to find every class that implements a contract.',
      'implementationProvider',
      'textDocument/implementation',
      positionParams,
    ),
  )

  ctx.tools.register(
    locationTool(
      'lsp_references',
      'Every place the symbol at a position is referenced, excluding its own declaration. Read-only. Use it before renaming or changing a signature to see the blast radius.',
      'referencesProvider',
      'textDocument/references',
      (uri, position) => ({
        textDocument: { uri },
        position,
        context: { includeDeclaration: false },
      }),
    ),
  )

  ctx.tools.register(
    defineTool({
      name: 'lsp_hover',
      description:
        'The type signature and documentation a language server shows for the symbol at a position. Read-only, and cheaper than reading the file when you only need a signature.',
      parameters: POSITION_PARAMS,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: (args, value) =>
          value.text === ''
            ? [{ type: 'text', text: `No results at ${args.file}:${args.line}:${args.character}` }]
            : [{ type: 'text', text: value.text }],
        presentationMeta: (_args, value) => (value.text === '' ? { useless: true } : {}),
      },
      async execute(args, exec) {
        const opened = await openForCall(callContext, args.file, exec)
        const { session, document, uri } = opened
        requireCapability(session, opened.serverId, 'hoverProvider', 'textDocument/hover')
        const position = document.toWire(args.line, args.character, session.encoding)
        const payload = await session.request('textDocument/hover', { textDocument: { uri }, position }, exec.signal)
        if (payload === null || typeof payload !== 'object' || !('contents' in payload)) return { text: '' }
        return { text: extractHoverText(payload.contents) }
      },
    }),
  )

  // Disposal must reclaim every child process: a hot unmount that leaked
  // language servers would leave them indexing forever.
  ctx.effect(
    () => async () => {
      const closing = [...sessions.values()]
      sessions.clear()
      await Promise.all(closing.map((session) => session.dispose().catch(() => {})))
    },
    'omd-lsp-nav session teardown',
  )
}

/**
 * Flatten a hover payload's `contents` into the text the model reads.
 *
 * The protocol allows three shapes: a plain string, `MarkupContent`
 * (`{ kind, value }`), or a `MarkedString[]` whose entries are either strings or
 * `{ language, value }`. A marked string naming a language is a code block and
 * is fenced; everything else keeps its own text.
 *
 * @param contents - the hover result's `contents` field, however malformed.
 * @returns the joined text, `''` when the server reported nothing usable.
 */
export function extractHoverText(contents: unknown): string {
  if (contents === null || contents === undefined) return ''
  if (typeof contents === 'string') return contents.trim()
  if (Array.isArray(contents)) {
    return contents
      .map((entry) => extractHoverText(entry))
      .filter((entry) => entry !== '')
      .join('\n\n')
  }
  if (typeof contents !== 'object') return ''
  if (!('value' in contents)) return ''
  const value = contents.value
  if (typeof value !== 'string') return ''
  const language = 'language' in contents && typeof contents.language === 'string' ? contents.language : ''
  return language === '' ? value.trim() : `\`\`\`${language}\n${value}\n\`\`\``
}
