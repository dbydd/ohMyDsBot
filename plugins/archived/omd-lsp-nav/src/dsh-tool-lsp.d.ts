/**
 * Ambient declarations for the internal modules of `dsh-tool-lsp` this package
 * imports.
 *
 * The community package ships plain JavaScript with no type declarations, and
 * deliberately publishes no service: its client lives in the closure of its own
 * `apply`. Importing the implementation is the only way to reach it, so the
 * signatures below are the exact surface this package depends on — nothing
 * more. Each declaration mirrors one function or class in the corresponding
 * `lib/*.js` file; when an upgrade of `dsh-tool-lsp` changes any of them, the
 * type check here fails before the tools can be called.
 *
 * Positions are declared structurally (`{ line, character }`) rather than with
 * named types, because the same pair crosses four module boundaries and the
 * shape — not the name — is what has to match.
 *
 * @module omd-lsp-nav/dsh-tool-lsp
 */

declare module 'dsh-tool-lsp/lib/servers.js' {
  /** One configured language server, resolved to a runnable entry. */
  export interface ResolvedServer {
    /** The user-chosen id from the `servers:` table. */
    readonly serverId: string
    /** The executable that was resolved, as recorded for diagnostics. */
    readonly executable: string
    /** The normalized launch spec. */
    readonly entry: {
      readonly args: readonly string[]
      readonly env: Record<string, string> | undefined
      readonly initializationOptions: unknown
      readonly configuration: unknown
      readonly maxMessageBytes: number | undefined
      readonly maxStderrBytes: number | undefined
      readonly killGraceMs: number | undefined
      readonly shutdownTimeoutMs: number | undefined
    }
  }

  /**
   * Validate every configured entry and resolve its executable.
   * @param ctx - anything with a `subprocess.spawn` seam to probe the command through.
   * @param servers - the raw `servers:` table.
   * @param signal - optional cancellation.
   * @returns the resolvable servers, in configuration order.
   */
  export function resolveServers(
    ctx: unknown,
    servers: Record<string, unknown>,
    signal?: AbortSignal | undefined,
  ): Promise<ResolvedServer[]>
}

declare module 'dsh-tool-lsp/lib/runner.js' {
  /**
   * A launcher the client calls with a spawn request it assembles itself.
   *
   * That request's shape belongs to the subprocess service, which this package
   * does not depend on, so the parameter is `never`: every real launcher accepts
   * it — nothing but `never` is assignable to `never`, and `never` is assignable
   * to any request type — which keeps the dependency surface at the client's own
   * API instead of another service's.
   */
  export type ClientSpawner = (spec: never) => unknown

  /** One open document, with the text and codec the server was told about. */
  export interface OpenDocumentHandle {
    /** The document's `file:` URI. */
    readonly uri: string
    /** The LSP language id it was opened with. */
    readonly languageId: string
    /** The LSP document version. */
    readonly version: number
    /** The exact text sent to the server. */
    readonly text: string
    /**
     * Convert a one-based UTF-16 position into the server's wire encoding.
     * @param line - one-based line.
     * @param character - one-based UTF-16 column.
     * @param encoding - the server's negotiated encoding.
     * @returns the zero-based wire position.
     */
    toWire(line: number, character: number, encoding: string): { line: number; character: number }
    /**
     * Convert a wire position back into the one-based model convention.
     * @param position - the zero-based wire position.
     * @param encoding - the server's negotiated encoding.
     * @returns the one-based UTF-16 position.
     */
    toModel(position: { line: number; character: number }, encoding: string): { line: number; character: number }
    /**
     * A converter from the server's encoding into zero-based UTF-16 positions.
     * @param encoding - the server's negotiated encoding.
     * @returns the per-payload converter the normalizers take.
     */
    decoder(encoding: string): (position: { line: number; character: number }) => { line: number; character: number }
  }

  /** A live session with one configured language server. */
  export class LspSession {
    /**
     * @param spec - the launch spec (command, args, cwd, limits).
     * @param spawner - the subprocess seam's `spawn`, bound to its service.
     * @param rootUri - the workspace root as a `file:` URI.
     * @param timeoutMs - the default per-request budget.
     */
    constructor(spec: unknown, spawner: ClientSpawner, rootUri: string, timeoutMs: number)
    /** The position encoding negotiated at `initialize`. */
    readonly encoding: string
    /** Whether the underlying process is still usable. */
    readonly alive: boolean
    /**
     * Start the server and complete the handshake, once.
     * @param signal - optional cancellation.
     * @returns once the session is usable.
     */
    start(signal?: AbortSignal | undefined): Promise<unknown>
    /**
     * Whether the server advertised a capability.
     * @param path - a dotted path into the capability object, e.g. `hoverProvider`.
     * @returns the capability value, or `undefined`.
     */
    capability(path: string): unknown
    /**
     * Open a document, or refresh it when the text changed.
     * @param uri - the document's `file:` URI.
     * @param languageId - the LSP language id.
     * @param text - the document text.
     * @returns the open document record.
     */
    openDocument(uri: string, languageId: string, text: string): Promise<OpenDocumentHandle>
    /**
     * Issue one request with the session's timeout applied.
     * @param method - the JSON-RPC method.
     * @param params - the request params.
     * @param signal - caller cancellation.
     * @param timeoutMs - an override budget.
     * @returns the server's result.
     */
    request(method: string, params: unknown, signal?: AbortSignal | undefined, timeoutMs?: number): Promise<unknown>
    /**
     * Forget a document, telling the server to drop it.
     * @param uri - the document's `file:` URI.
     * @returns once the notification is sent.
     */
    closeDocument(uri: string): Promise<void>
    /**
     * Close documents and shut the server down. Idempotent.
     * @returns once the process is gone.
     */
    dispose(): Promise<void>
  }
}

declare module 'dsh-tool-lsp/lib/executor.js' {
  import type { LspSession, OpenDocumentHandle } from 'dsh-tool-lsp/lib/runner.js'
  import type { ResolvedServer } from 'dsh-tool-lsp/lib/servers.js'

  /** One call's resolved document: server, open document, and workspace root. */
  export interface OpenedCall {
    /** The session serving this file. */
    readonly session: LspSession
    /** The document, already open on that session. */
    readonly document: OpenDocumentHandle
    /** The absolute path on disk. */
    readonly path: string
    /** The path as the model should see it. */
    readonly displayPath: string
    /** The document's `file:` URI. */
    readonly uri: string
    /** The text sent to the server. */
    readonly text: string
    /** The workspace root, as a path and a `file:` URI. */
    readonly root: { readonly path: string; readonly uri: string }
    /** The entry that claimed this file. */
    readonly server: ResolvedServer
    /** That entry's id. */
    readonly serverId: string
    /** The LSP language id the file was opened with. */
    readonly languageId: string
  }

  /**
   * Resolve the workspace root as both a path and a `file:` URI.
   * @param fs - the filesystem seam.
   * @param root - the workspace root path.
   * @param signal - optional cancellation.
   * @returns the resolved root.
   */
  export function resolveRoot(
    fs: unknown,
    root: string,
    signal?: AbortSignal | undefined,
  ): Promise<{ path: string; uri: string }>

  /**
   * Route one call's file to the server that owns it, and open it.
   * @param ctx - the per-call context: `fs`, servers, sessions, `rootFor`, `sessionFor`.
   * @param filePath - the caller's path, workspace-relative or absolute.
   * @param exec - the tool execution, carrying the calling agent and signal.
   * @returns the opened document.
   */
  export function openForCall(ctx: unknown, filePath: string, exec: unknown): Promise<OpenedCall>
}

declare module 'dsh-tool-lsp/lib/translate.js' {
  /** One server-reported location, normalized into the model convention. */
  export interface NormalizedLocation {
    /** The filesystem path the URI pointed at. */
    readonly file_path: string
    /** The zero-based UTF-16 range. */
    readonly range: {
      readonly start: { readonly line: number; readonly character: number }
      readonly end: { readonly line: number; readonly character: number }
    }
    /** The one-based start position. */
    readonly start: { readonly line: number; readonly character: number }
    /** The one-based end position. */
    readonly end: { readonly line: number; readonly character: number }
  }

  /**
   * Normalize a `Location`, resolving `LocationLink` fields too.
   * @param value - the server's location entry.
   * @param decode - the wire → zero-based UTF-16 converter.
   * @returns the normalized location.
   */
  export function normalizeLocation(
    value: unknown,
    decode: (position: { line: number; character: number }) => { line: number; character: number },
  ): NormalizedLocation

  /**
   * Strip a `file:` URI to its path, tolerating non-URI paths.
   * @param uri - the server-reported URI or path.
   * @returns the filesystem path.
   */
  export function uriToPath(uri: string): string
}

declare module 'dsh-tool-lsp/lib/render.js' {
  /**
   * Render a path relative to the workspace root when it sits inside it.
   * @param path - the absolute path.
   * @param root - the workspace root.
   * @returns the path to show the model.
   */
  export function displayPath(path: string, root: string): string
}

declare module 'dsh-tool-lsp/lib/patch-config.js' {
  /** The merged `- id: lsp` rows of the profile's patch layer. */
  export interface PatchLayerLspConfig {
    /** The `servers:` table, when the patch layer declared one. */
    readonly servers?: Record<string, unknown> | undefined
  }

  /**
   * Read the language-server table out of the profile's patch layer.
   * @param patchPath - an explicit patch path; defaults to the profile's own.
   * @returns the merged config, or `null` when the layer has none.
   */
  export function loadPatchLayerLspConfig(patchPath?: string | undefined): PatchLayerLspConfig | null
}

declare module 'dsh-tool-lsp/lib/vocabulary.js' {
  /** The error codes the client classifies failures under. */
  export const LSP_ERROR: {
    readonly NO_SERVER: string
    readonly UNSUPPORTED: string
    readonly SERVER_ERROR: string
    readonly SERVER_FAILED: string
    readonly TIMEOUT: string
    readonly COMMAND_NOT_FOUND: string
    readonly REQUEST_CANCELLED: string
    readonly WRITE_CONFLICT: string
  }

  /**
   * Build an error carrying one of the client's stable codes.
   * @param code - the code, normally a value from {@link LSP_ERROR}.
   * @param message - the message the model will read.
   * @returns the error, ready to throw.
   */
  export function lspError(code: string, message: string): Error
}
