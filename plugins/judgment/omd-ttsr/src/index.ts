/**
 * omd-ttsr — streaming text-triggered stop-and-retry rules.
 *
 * A rule is a markdown file whose frontmatter carries a regular expression.
 * While the model streams, the accumulated text is tested against every rule.
 * A match abandons the attempt and lets the agent loop retry it with the rule
 * text in context, so the rule teaches the model instead of only vetoing it.
 *
 * **How the attempt is abandoned.** `llm/stream` hands chunks straight to the
 * agent loop, which pushes each one into the live attempt. Chunks are forwarded
 * as they arrive, so the typing effect stays intact. When a rule matches, this
 * wrapper stops the upstream iterator and yields one synthetic `finish` chunk
 * with `reason.kind: 'error'`. That is the same terminal shape a provider
 * failure produces, so the loop takes its normal recovery path: it settles the
 * attempt as `assistant/attempt` and waterfalls `agent/request-error`.
 *
 * **Why `assistant/attempt` matters.** A settled attempt never enters
 * `deriveMessages()`, so the half-written answer cannot leak into the next
 * request. The loop rebuilds the request from the session log, which is why the
 * rule text must be appended as a durable `user/message` rather than smuggled
 * through `options`: a retry carries no state from this wrapper.
 *
 * Known limitations:
 *
 * - The matched prefix stays on screen until the retry commits, then it is
 *   replaced. That brief flicker is the price of streaming; buffering the whole
 *   attempt removes it and removes the typing effect with it.
 * - Cancelling the upstream iterator reaches the adapter's fetch only when the
 *   provider honours cancellation. A provider that ignores it finishes the
 *   abandoned attempt in the background; the retry still owns the result.
 * - A rule fires once per session by default (`repeatMode: once`); `after-gap`
 *   re-arms it after `repeatGap` attempts. Fired rules live in process memory;
 *   a tree-external plugin cannot append its own session event type, so a
 *   restart forgets them.
 * - `scope` is honoured for `text` (default) and `thinking`, and the thinking
 *   scan is gated by `scanThinking`. A `tool:` scope has no meaning in a text
 *   stream and is ignored.
 *
 * @module omd-ttsr
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    /** A correction injected after a stream rule matched. */
    'omd-ttsr': { kind: 'omd-ttsr'; rule: string }
  }
}

/** Machine code carried by the synthetic finish chunk that abandons an attempt. */
export const TTSR_FAILURE_CODE = 'OMD_TTSR_TRIGGERED'

/** One loaded rule. */
export interface Rule {
  /** Identity used for once-only tracking, from `name` or the file name. */
  name: string
  /** One-line account for diagnostics. */
  description: string
  /** Pattern tested against the accumulated text of one attempt. */
  condition: RegExp
  /** Which stream to scan: `text` (default), `thinking`, or any other tag. */
  scope: string
  /** `abort` abandons and retries; `warn` only reports that the rule matched. */
  interruptMode: 'abort' | 'warn'
  /** Text appended to the retry as a durable user message. */
  body: string
}

/** Plugin configuration. */
export interface Config {
  /** Mount the wrapper at all. When false, `apply` registers nothing. */
  enabled: boolean
  /** Extra rule directories, searched after the two defaults. */
  ruleDirs: string[]
  /** Interrupt mode for rules whose frontmatter names none. */
  interruptMode: Volatile<'abort' | 'warn'>
  /** `once` retires a rule per session; `after-gap` re-arms it after `repeatGap` attempts. */
  repeatMode: Volatile<'once' | 'after-gap'>
  /** Attempts between two firings of the same rule under `after-gap`. */
  repeatGap: Volatile<number>
  /** Scan `reasoning-delta` text as well as `text-delta`. */
  scanThinking: Volatile<boolean>
  /** Characters accumulated per attempt before scanning stops. */
  maxAccumulatedChars: number
}

/** Every key has a default so an empty patch row mounts. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('Install the stream wrapper. With no rule files loaded it is a passthrough.'),
  ruleDirs: z.array(z.string()).default([]).description('Extra rule directories, searched after $DSH_HOME/ttsr-rules and <cwd>/.dsh/ttsr-rules.'),
  interruptMode: z.union(['abort', 'warn']).default('abort')
    .volatile()
    .description('Default for rules whose frontmatter names no `interruptMode`: `abort` discards the attempt and retries, `warn` only logs.'),
  repeatMode: z.union(['once', 'after-gap']).default('once')
    .volatile()
    .description('`once` fires a rule at most once per session; `after-gap` re-arms it after `repeatGap` attempts.'),
  repeatGap: z.natural().default(10)
    .volatile()
    .description('Attempts between two firings of the same rule under `after-gap`.'),
  scanThinking: z.boolean().default(true)
    .volatile()
    .description('Scan reasoning text as well as answer text.'),
  maxAccumulatedChars: z.natural().default(200_000)
    .description('Characters accumulated per attempt before scanning stops, so a runaway answer cannot grow memory without bound.'),
})

/** Attempts seen per session id, so `after-gap` can measure distance. */
const attemptsBySession = new Map<string, number>()

/** Attempt index at which each rule last fired, per session id. */
const firedAtBySession = new Map<string, Map<string, number>>()

/** Split YAML-ish frontmatter from a rule body. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw)
  if (match === null) return { meta: {}, body: raw }
  const head = match[1] ?? ''
  const body = match[2] ?? ''
  const meta: Record<string, string> = {}
  for (const line of head.split(/\r?\n/u)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/gu, '')
    if (key !== '') meta[key] = value
  }
  return { meta, body }
}

/**
 * Read every rule file from the configured directories.
 * @param extraDirs - additional directories from `Config.ruleDirs`.
 * @param defaultInterruptMode - used by rules whose frontmatter names none.
 * @param onError - receives one line per rule file that was skipped.
 * @returns the loaded rules, first definition of a name winning.
 */
export function loadRules(
  extraDirs: readonly string[],
  defaultInterruptMode: 'abort' | 'warn' = 'abort',
  onError: (message: string) => void = () => {},
): Rule[] {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dirs = [join(home, 'ttsr-rules'), join(process.cwd(), '.dsh', 'ttsr-rules'), ...extraDirs]
  const rules: Rule[] = []
  const seen = new Set<string>()

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const file of entries) {
      if (!file.endsWith('.md')) continue
      let raw: string
      try {
        raw = readFileSync(join(dir, file), 'utf8')
      } catch {
        continue
      }
      const { meta, body } = parseFrontmatter(raw)
      const source = meta.condition ?? ''
      if (source.trim() === '') {
        onError(`ttsr: ${join(dir, file)} has no condition; skipped`)
        continue
      }
      const name = meta.name ?? file.replace(/\.md$/u, '')
      if (seen.has(name)) continue
      let condition: RegExp
      try {
        condition = new RegExp(source, meta.flags ?? 'u')
      } catch (error) {
        onError(`ttsr: ${join(dir, file)} has an invalid condition (${error instanceof Error ? error.message : String(error)}); skipped`)
        continue
      }
      seen.add(name)
      rules.push({
        name,
        description: meta.description ?? '',
        condition,
        scope: meta.scope ?? 'text',
        interruptMode: meta.interruptMode === 'warn'
          ? 'warn'
          : meta.interruptMode === 'abort' ? 'abort' : defaultInterruptMode,
        body: body.trim(),
      })
    }
  }
  return rules
}

/** Read (or create) the firing record for one session key. */
function firedAtFor(key: string): Map<string, number> {
  const existing = firedAtBySession.get(key)
  if (existing !== undefined) return existing
  const created = new Map<string, number>()
  firedAtBySession.set(key, created)
  return created
}

/** The durable user message a retry receives. */
function correction(rule: Rule): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        `A stream rule stopped your previous answer. Rule "${rule.name}" matched while you were writing.`,
        'The partial answer was discarded. Continue the task, and follow this rule from now on:',
        '',
        rule.body,
      ].join('\n'),
    }],
    source: { kind: 'omd-ttsr', rule: rule.name },
  })
}

/**
 * Mount the wrapper.
 * @param ctx - plugin context with the LLM runtime.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  /** Abandoned attempts awaiting their retry, per session id. */
  const pending = new Map<string, Rule>()

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    const rules = loadRules(config.ruleDirs, config.interruptMode.get(), message => ctx.logger.warn(message))
    if (rules.length === 0) return next()
    const sessionKey = options.sessionId === undefined ? '' : String(options.sessionId)
    const attempt = (attemptsBySession.get(sessionKey) ?? 0) + 1
    attemptsBySession.set(sessionKey, attempt)
    const firedAt = firedAtFor(sessionKey)
    const rearm = (rule: Rule): boolean => {
      const last = firedAt.get(rule.name)
      if (last === undefined) return true
      return config.repeatMode.get() === 'after-gap' && attempt - last >= config.repeatGap.get()
    }

    return (async function* guarded(): AsyncGenerator<StreamChunk> {
      let text = ''
      let thinking = ''
      const iterator = next()[Symbol.asyncIterator]()
      let matched: Rule | undefined
      try {
        for (;;) {
          const step = await iterator.next()
          if (step.done === true) break
          const chunk = step.value
          // The upstream finish is withheld until the whole attempt has been
          // checked, so a match can replace it with the error terminal.
          if (chunk.type === 'finish') {
            if (matched === undefined) yield chunk
            break
          }
          if (chunk.type === 'text-delta') {
            if (text.length < config.maxAccumulatedChars) text += chunk.text
            for (const rule of rules) {
              if (!rearm(rule) || rule.scope === 'thinking') continue
              rule.condition.lastIndex = 0
              if (rule.condition.test(text)) {
                matched = rule
                break
              }
            }
          } else if (chunk.type === 'reasoning-delta') {
            if (thinking.length < config.maxAccumulatedChars) thinking += chunk.text
            if (!config.scanThinking.get()) {
              yield chunk
              continue
            }
            for (const rule of rules) {
              if (!rearm(rule) || rule.scope !== 'thinking') continue
              rule.condition.lastIndex = 0
              if (rule.condition.test(thinking)) {
                matched = rule
                break
              }
            }
          }
          yield chunk
          if (matched !== undefined) break
        }
      } finally {
        try {
          await iterator.return?.(undefined)
        } catch {
          // A refusing provider leaves the abandoned attempt running; the retry
          // below still owns the visible result.
        }
      }

      if (matched === undefined) return
      firedAt.set(matched.name, attempt)

      if (matched.interruptMode === 'warn') {
        ctx.logger.info('ttsr: rule matched; warning only', { rule: matched.name })
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      ctx.logger.info('ttsr: rule matched; abandoning the attempt', { rule: matched.name })
      pending.set(sessionKey, matched)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `ttsr: rule "${matched.name}" matched`, code: TTSR_FAILURE_CODE },
        },
      }
    })()
  }, { global: true, prepend: true })

  ctx.on('agent/request-error', async (payload, next) => {
    if (payload.failure.code !== TTSR_FAILURE_CODE) return next()
    const sessionKey = String(payload.agent.session.id)
    const rule = pending.get(sessionKey)
    if (rule === undefined) return next()
    pending.delete(sessionKey)
    // The retry rebuilds its request from the session log, so the rule must be
    // durable before the loop re-derives messages.
    payload.agent.session.append('user/message', correction(rule), { surfaceOp: 'append' })
    return { kind: 'retry' }
  })

  ctx.effect(() => () => {
    pending.clear()
    attemptsBySession.clear()
    firedAtBySession.clear()
  }, 'omd-ttsr: drop investigation state')
}
