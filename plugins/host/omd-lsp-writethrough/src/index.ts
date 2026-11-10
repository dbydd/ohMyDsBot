/**
 * omd-lsp-writethrough — language-server diagnostics written straight back into
 * the tool result that caused them.
 *
 * The model writes a file and moves on. Without this plugin the only way it
 * learns the write did not compile is to run a whole-project build or remember
 * to call `lsp_diagnostics` — so a broken edit survives several more turns and
 * the repair costs a fresh read of a file it just wrote. This plugin closes that
 * loop at the exact moment the write lands: the diagnostics ride the same tool
 * result, so the model sees the failure before it forms its next sentence.
 *
 * Two constraints shape the implementation:
 *
 *  - **The tool result is sacred.** A clean write is returned byte-identical:
 *    nothing is appended when there is nothing to report. Diagnostics are only
 *    ever added as a trailing block, never substituted for the write's own text.
 *  - **A slow server may not block the model.** The fast path has two seconds;
 *    whatever a slower server produces is parked and injected into the next
 *    admitted step instead of holding the tool call open.
 *
 * `dsh-tool-lsp` owns the language-server processes and publishes no service
 * that hands out diagnostics, so this plugin calls its `lsp_diagnostics` tool
 * and parses the rendered lines. That avoids a second server process per
 * workspace; see `src/parse.ts` for the trade.
 *
 * @module omd-lsp-writethrough
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { DeferredDiagnostics, type DeferredNotice } from './deferred.ts'
import {
  filterOrphanProjectDiagnostics,
  TYPESCRIPT_PROJECT_MARKER,
  type NormalizedDiagnostic,
} from './filter.ts'
import {
  appendDiagnostics,
  diagnosticKey,
  formatDeferredNotice,
  formatDiagnosticsBlock,
} from './format.ts'
import { parseDiagnosticsText, textOfContent } from './parse.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Late language-server diagnostics injected after a write completed.
     * @persistenceAttribution
     */
    'omd-lsp-writethrough': { kind: 'omd-lsp-writethrough' }
  }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'omd-lsp-writethrough'

/** Services required by this plugin. */
export const inject = ['tools']

/**
 * Tools whose successful result may trigger a diagnostics pass.
 *
 * `edit`/`write` are the `dsh-tool-fs` pair the `omd` profile uses.
 * `str_replace_editor` stays in the set for a composition that disables
 * `tool-fs` and mounts the editor instead; its `view` command is read-only and
 * is filtered out by {@link isMutatingCall}.
 */
const MUTATING_TOOLS: Readonly<Record<string, true>> = {
  edit: true,
  write: true,
  str_replace_editor: true,
}

/** Severities worth interrupting the model for. `information` and `hint` are noise after a write. */
const SURFACED_SEVERITIES: Readonly<Record<NormalizedDiagnostic['severity'], boolean>> = {
  error: true,
  warning: true,
  information: false,
  hint: false,
}

/** Sentinel for a fast-path fetch that missed its budget. */
const DEADLINE_PASSED = Symbol('omd-lsp-writethrough/deadline-passed')

/** Plugin configuration: the fast-path budget, the deferred budget, and the display cap. */
export interface Config {
  /** Milliseconds the tool result may wait for diagnostics before deferring them. */
  timeoutMs?: number
  /** Milliseconds a deferred fetch may run before it is abandoned. */
  deferredTimeoutMs?: number
  /** Maximum diagnostics appended to one result or notice. */
  maxDiagnostics?: number
}

/** The schema the loader validates {@link Config} against; every field has a working default. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(2000).description('Fast-path diagnostics budget in milliseconds.'),
  deferredTimeoutMs: z.number().default(12000).description('Deferred diagnostics budget in milliseconds.'),
  maxDiagnostics: z.number().default(20).description('Maximum diagnostics appended to one result or notice.'),
})

/** Per-agent, per-file deduplication ledger and the write token that orders results. */
interface FileState {
  /** Increments on every write of this path, so a superseded fetch can tell it lost. */
  token: number
  /** Diagnostic identities already shown for this path; replaced, never accumulated. */
  ledger: Set<string>
}

/** The two renderings one diagnostics pass produces. */
interface Rendered {
  /** The block appended to the tool result; `''` when nothing is new. */
  block: string
  /** The deferred notice body; `''` when nothing is new. */
  notice: string
  /** How many new diagnostics existed before the cap. */
  fresh: number
}

/**
 * Mount the writethrough: the post-execute pass, the deferred drain, and their cleanup.
 *
 * @param ctx - the plugin context; must inject `tools`.
 * @param config - the resolved configuration.
 * @throws when a configured budget is not a positive integer, so a typo fails at load.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  const timeoutMs = config.timeoutMs ?? 2000
  const deferredTimeoutMs = config.deferredTimeoutMs ?? 12000
  const maxDiagnostics = config.maxDiagnostics ?? 20
  requirePositiveInteger('timeoutMs', timeoutMs)
  requirePositiveInteger('deferredTimeoutMs', deferredTimeoutMs)
  requirePositiveInteger('maxDiagnostics', maxDiagnostics)

  const queue = new DeferredDiagnostics()
  const states = new Map<Agent, Map<string, FileState>>()
  const deferredTimers = new Set<NodeJS.Timeout>()
  const inFlight = new Set<AbortController>()
  let callSequence = 0

  /**
   * Get or create the ledger state for one agent and one written path.
   * @param agent - the agent that wrote the file.
   * @param file - the written path.
   * @returns the ledger state for that `(agent, file)` pair.
   */
  const stateFor = (agent: Agent, file: string): FileState => {
    let byFile = states.get(agent)
    if (byFile === undefined) {
      byFile = new Map()
      states.set(agent, byFile)
    }
    let state = byFile.get(file)
    if (state === undefined) {
      state = { token: 0, ledger: new Set() }
      byFile.set(file, state)
    }
    return state
  }

  /**
   * Compute the new diagnostics for one pass and advance the ledger.
   *
   * The ledger is replaced with the current set, not merged: a diagnostic that
   * was fixed and later reintroduced is a new problem and must be reported
   * again, which a merge would suppress forever.
   *
   * @param state - the ledger state for this file.
   * @param file - the written path.
   * @param diagnostics - every diagnostic the server reported for the file.
   * @returns the two renderings and the count of new surfaced diagnostics.
   */
  const consume = (state: FileState, file: string, diagnostics: readonly NormalizedDiagnostic[]): Rendered => {
    const filtered = filterOrphanProjectDiagnostics(diagnostics, hasTypescriptProject(file))
    const fresh = filtered.filter((diagnostic) => !state.ledger.has(diagnosticKey(diagnostic)))
    state.ledger = new Set(filtered.map(diagnosticKey))
    const surfaced = fresh.filter((diagnostic) => SURFACED_SEVERITIES[diagnostic.severity])
    const shown = surfaced.slice(0, maxDiagnostics)
    return {
      block: formatDiagnosticsBlock(file, shown, surfaced.length),
      notice: formatDeferredNotice(file, shown, surfaced.length),
      fresh: surfaced.length,
    }
  }

  /**
   * Fetch diagnostics for one file through the community LSP tool.
   * @param agent - the agent the call runs for, so tool scoping matches the write.
   * @param file - the written path.
   * @param signal - cancels the LSP call.
   * @returns the parsed diagnostics, or `null` when no server answered.
   */
  const fetchDiagnostics = async (
    agent: Agent | undefined,
    file: string,
    signal: AbortSignal,
  ): Promise<readonly NormalizedDiagnostic[] | null> => {
    callSequence += 1
    try {
      const input = {
        callId: ToolCallId(`omd-lsp-writethrough:${callSequence}`),
        name: 'lsp_diagnostics',
        arguments: { file_path: file },
        signal,
      }
      const result = await ctx.tools.execute(agent === undefined ? input : { ...input, agent })
      if (result.isError) return null
      return parseDiagnosticsText(textOfContent(result.content))
    } catch {
      // No configured server claims the file, or the server failed to answer.
      // Either way the write stays clean and the model is told nothing.
      return null
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    if (result.isError) return decision
    if (!isMutatingCall(exec)) return decision
    // An accept that replaced the value cannot also carry content.
    if (Object.hasOwn(decision, 'value')) return decision
    const agent = exec.agent
    if (agent === undefined) return decision
    const file = writtenPath(exec, result)
    if (file === undefined) return decision

    const state = stateFor(agent, file)
    state.token += 1
    const token = state.token

    const controller = new AbortController()
    inFlight.add(controller)
    const fetch = fetchDiagnostics(agent, file, controller.signal)
    const raced = await raceTimeout(fetch, timeoutMs)

    if (raced === DEADLINE_PASSED) {
      // Slow path: hand the in-flight fetch to the queue and let the tool result
      // return now. The fetch keeps running under its own budget.
      const publish = queue.register(agent, file, String(token))
      const cap = setTimeout(() => controller.abort(), deferredTimeoutMs)
      deferredTimers.add(cap)
      // `fetchDiagnostics` never rejects: every failure is folded into `null`, so
      // one continuation covers both the answer and the abandonment case.
      void fetch.then((diagnostics) => {
        inFlight.delete(controller)
        clearTimeout(cap)
        deferredTimers.delete(cap)
        if (diagnostics === null || state.token !== token) {
          publish(undefined)
          return
        }
        const rendered = consume(state, file, diagnostics)
        publish(rendered.fresh === 0 ? undefined : { text: rendered.notice })
      })
      return decision
    }

    inFlight.delete(controller)
    if (raced === null || state.token !== token) return decision
    const rendered = consume(state, file, raced)
    if (rendered.block === '') return decision
    const base = decision.content ?? result.content
    const content = [...appendDiagnostics(base, rendered.block)]
    return decision.additionalContexts === undefined
      ? { kind: 'accept', content }
      : { kind: 'accept', content, additionalContexts: decision.additionalContexts }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const notices: DeferredNotice[] = queue.take(payload.agent)
    for (const notice of notices) {
      try {
        payload.agent.inject(createUserMessage({
          content: [{ type: 'text', text: notice.text }],
          source: { kind: 'omd-lsp-writethrough' },
        }))
      } catch {
        // A disposing agent rejects injection; the notice is dropped rather than
        // failing the step it was meant to inform.
      }
    }
    return decision
  })

  ctx.effect(() => () => {
    queue.clear()
    for (const timer of deferredTimers) clearTimeout(timer)
    deferredTimers.clear()
    for (const controller of inFlight) controller.abort()
    inFlight.clear()
    states.clear()
  }, 'omd-lsp-writethrough cleanup')
}

/**
 * Whether one call mutates a file.
 *
 * `str_replace_editor` multiplexes read and write behind `command`; its `view`
 * command is a read and must not trigger a diagnostics pass.
 *
 * @param exec - the tool execution.
 * @returns true when the call wrote to disk.
 */
function isMutatingCall(exec: ToolExecution): boolean {
  if (MUTATING_TOOLS[exec.name] !== true) return false
  if (exec.name !== 'str_replace_editor') return true
  const command = argumentString(exec.arguments, 'command')
  return command === 'create' || command === 'str_replace' || command === 'insert'
}

/**
 * Read the path a mutating tool wrote.
 *
 * `edit`/`write` fill `presentationMeta.path` with the canonical absolute path;
 * `str_replace_editor` has no presentation meta and takes an absolute `path`
 * argument instead.
 *
 * @param exec - the tool execution.
 * @param result - its settled result.
 * @returns the written path, or `undefined` when no source carries one.
 */
function writtenPath(exec: ToolExecution, result: Readonly<ToolExecutionResult>): string | undefined {
  const fromMeta = metaPath(result.meta)
  if (fromMeta !== undefined) return fromMeta
  const fromFilePath = argumentString(exec.arguments, 'file_path')
  if (fromFilePath !== undefined) return fromFilePath
  return argumentString(exec.arguments, 'path')
}

/**
 * Read `meta.path` from a result's presentation metadata.
 * @param meta - the result's `meta`, a `JsonValue` at the type level.
 * @returns the path string, or `undefined` when the shape does not carry one.
 */
function metaPath(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const path = (meta as Record<string, unknown>).path
  return typeof path === 'string' && path.trim() !== '' ? path : undefined
}

/**
 * Read one string field from a tool's validated arguments.
 * @param args - the execution's parsed arguments.
 * @param key - the field to read.
 * @returns the field's value, or `undefined` when the shape does not carry a non-empty string.
 */
function argumentString(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Whether a TypeScript project governs a file, by walking its ancestors for `tsconfig.json`.
 *
 * A relative path cannot be walked against the real filesystem, and assuming a
 * project exists is the safe answer: it disables the orphan filter rather than
 * dropping real diagnostics.
 *
 * @param file - the absolute path the tool reported, when it reported one.
 * @returns true when a `tsconfig.json` exists at or above the file, or when the path cannot be walked.
 */
function hasTypescriptProject(file: string): boolean {
  if (!isAbsolute(file)) return true
  let directory = dirname(file)
  for (;;) {
    if (existsSync(join(directory, TYPESCRIPT_PROJECT_MARKER))) return true
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

/**
 * Race a promise against a deadline.
 * @param promise - the work to bound.
 * @param ms - the budget in milliseconds.
 * @returns the promise's value, or {@link DEADLINE_PASSED} when the budget elapsed first.
 */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof DEADLINE_PASSED> {
  const deadline = Promise.withResolvers<typeof DEADLINE_PASSED>()
  const timer = setTimeout(() => deadline.resolve(DEADLINE_PASSED), ms)
  return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer))
}

/**
 * Reject a configuration value that is not a positive integer at load.
 * @param key - the configuration key, for the error message.
 * @param value - the resolved value.
 * @throws when `value` is not a positive finite integer.
 */
function requirePositiveInteger(key: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`omd-lsp-writethrough: ${key} must be a positive integer, got ${String(value)}`)
  }
}
