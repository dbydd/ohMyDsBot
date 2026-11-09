/**
 * Native System One backend: post the request body verbatim to a TypeSafe
 * judgment endpoint and read the answer map back.
 *
 * The wire is the provider's own — `{ model, state, questions }` out,
 * `{ model?, answers, usage? }` back — so nothing here interprets semantics;
 * normalization happens once in `answers.ts`. What this module owns is
 * transport policy: question batching, bounded concurrency, retry with
 * backoff, and the abort/timeout envelope.
 *
 * @module omd-judgment/native
 */

import { normalizeAnswers } from './answers.ts'
import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from './types.ts'
import { JudgmentHttpError, JudgmentParseError } from './types.ts'

/** Everything one native candidate needs to answer. */
export interface NativeJudgeOptions {
  /** Route label reported in results and diagnostics, e.g. `magpie`. */
  provider: string
  /** Model id posted in the request body. */
  model: string
  /** Origin without a trailing slash; `/v1/systemone` is appended. */
  baseUrl: string
  /** Bearer credential; omitted for an unauthenticated local gateway. */
  apiKey?: string
  /** Whole-call budget in milliseconds. */
  timeoutMs: number
  /** Maximum questions per request; larger requests are sliced. */
  maxQuestions: number
  /** Maximum slices in flight at once. */
  concurrency: number
  /** Retryable-attempt ceiling per slice, including the first try. */
  attempts: number
}

/** Backoff base in milliseconds. */
const BACKOFF_BASE_MS = 500
/** Backoff ceiling in milliseconds. */
const BACKOFF_CAP_MS = 5000

/** Read `Retry-After` as a delay in milliseconds, when the server sent one. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}

/** Whether a status is worth another attempt. */
function retryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

/** Sleep that rejects with the signal's reason when cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const onAbort = (): void => {
    clearTimeout(timer)
    reject(abortReason(signal))
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  signal.addEventListener('abort', onAbort, { once: true })
  return promise
}

/**
 * The reason a signal carries, as an Error.
 * @param signal - an aborted signal.
 * @returns the signal's own reason when it is an Error, otherwise a plain abort.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('judgment aborted')
}

/** Merge the caller's signal with a fresh per-call timeout. */
function deadline(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`judgment: timed out after ${timeoutMs}ms`)), timeoutMs)
  const forward = (): void => controller.abort(abortReason(signal as AbortSignal))
  if (signal === undefined) {
    return {
      signal: controller.signal,
      cancel: () => clearTimeout(timer),
    }
  }
  if (signal.aborted) {
    clearTimeout(timer)
    controller.abort(abortReason(signal))
    return { signal: controller.signal, cancel: () => {} }
  }
  signal.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    },
  }
}

/** One slice's outcome, keeping usage even when a sibling slice later fails. */
interface SliceOutcome {
  /** Raw answers keyed by question id. */
  answers: Record<string, unknown>
  /** Provider-reported model id, when it named one. */
  model: string | undefined
  /** Provider-reported token usage. */
  usage: { inputTokens: number; outputTokens: number }
}

/** Parse the provider's usage fields into the harness vocabulary. */
function readUsage(raw: unknown): { inputTokens: number; outputTokens: number } {
  if (raw === null || typeof raw !== 'object') return { inputTokens: 0, outputTokens: 0 }
  const record = raw as Record<string, unknown>
  const input = typeof record.input_tokens === 'number' ? record.input_tokens : 0
  const output = typeof record.output_tokens === 'number' ? record.output_tokens : 0
  return { inputTokens: Number.isFinite(input) ? input : 0, outputTokens: Number.isFinite(output) ? output : 0 }
}

/** POST one slice, retrying the statuses the provider asks us to retry. */
async function postSlice(
  options: NativeJudgeOptions,
  state: JudgmentRequest['state'],
  questions: Questions,
  signal: AbortSignal,
): Promise<SliceOutcome> {
  const url = `${options.baseUrl.replace(/\/+$/u, '')}/v1/systemone`
  let lastStatus = 0
  let lastBody = ''
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    signal.throwIfAborted()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    }
    if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: options.model, state, questions }),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw abortReason(signal)
      if (attempt === options.attempts) {
        throw new Error(`judgment: ${options.provider}/${options.model} unreachable: ${String(error)}`)
      }
      await sleep(backoff(attempt), signal)
      continue
    }

    if (!response.ok) {
      lastStatus = response.status
      lastBody = await response.text().catch(() => '')
      if (!retryable(response.status) || attempt === options.attempts) {
        throw new JudgmentHttpError(
          `judgment: ${options.provider}/${options.model} answered ${response.status}${lastBody === '' ? '' : `: ${lastBody.slice(0, 200)}`}`,
          response.status,
        )
      }
      const hinted = retryAfterMs(response)
      await sleep(hinted ?? backoff(attempt), signal)
      continue
    }

    const payload: unknown = await response.json().catch((error: unknown) => {
      throw new JudgmentParseError(`judgment: ${options.provider}/${options.model} returned invalid JSON: ${String(error)}`)
    })
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new JudgmentParseError(`judgment: ${options.provider}/${options.model} returned a non-object payload`)
    }
    const record = payload as Record<string, unknown>
    if (record.answers === null || typeof record.answers !== 'object' || Array.isArray(record.answers)) {
      throw new JudgmentParseError(`judgment: ${options.provider}/${options.model} returned no answers map`)
    }
    return {
      answers: record.answers as Record<string, unknown>,
      model: typeof record.model === 'string' ? record.model : undefined,
      usage: readUsage(record.usage),
    }
  }
  throw new JudgmentHttpError(
    `judgment: ${options.provider}/${options.model} answered ${lastStatus || 'nothing'} after ${options.attempts} attempts`,
    lastStatus,
  )
}

/** Exponential delay for one attempt, capped so a long outage never stalls a turn. */
function backoff(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
}

/** Slice a question map into ordered chunks of at most `size` entries. */
function chunk(questions: Questions, size: number): Questions[] {
  const slices: Questions[] = []
  const entries = Object.entries(questions)
  for (let index = 0; index < entries.length; index += size) {
    const slice: Questions = {}
    for (const [key, question] of entries.slice(index, index + size)) slice[key] = question
    slices.push(slice)
  }
  return slices
}

/**
 * Build the native judge for one endpoint.
 * @param options - transport and batching policy for this candidate.
 * @returns a judge that posts to `<baseUrl>/v1/systemone`.
 */
export function createNativeJudge(options: NativeJudgeOptions): Judge {
  const label = `${options.provider}/${options.model}`
  return {
    label,
    async judge<Q extends Questions>(request: JudgmentRequest<Q>, judgeOptions: JudgeOptions = {}): Promise<JudgmentResult<Q>> {
      const questions = request.questions
      if (Object.keys(questions).length === 0) {
        return {
          api: 'typesafe',
          provider: options.provider,
          model: options.model,
          answers: {} as { [K in keyof Q]: never },
          usage: { inputTokens: 0, outputTokens: 0 },
        }
      }

      const { signal, cancel } = deadline(judgeOptions.signal, options.timeoutMs)
      try {
        const slices = chunk(questions, options.maxQuestions)
        const merged: Record<string, unknown> = {}
        let reportedModel: string | undefined
        let inputTokens = 0
        let outputTokens = 0

        // A failing slice aborts its siblings; usage from slices that already
        // settled is kept so the caller still sees what was actually billed.
        let firstError: unknown
        const inFlight = new Set<Promise<void>>()
        let cursor = 0
        const worker = async (): Promise<void> => {
          while (cursor < slices.length && firstError === undefined) {
            const slice = slices[cursor] as Questions
            cursor += 1
            try {
              const outcome = await postSlice(options, request.state, slice, signal)
              for (const [key, value] of Object.entries(outcome.answers)) merged[key] = value
              reportedModel ??= outcome.model
              inputTokens += outcome.usage.inputTokens
              outputTokens += outcome.usage.outputTokens
            } catch (error) {
              if (firstError === undefined) firstError = error
              return
            }
          }
        }
        const lanes = Math.max(1, Math.min(options.concurrency, slices.length))
        for (let lane = 0; lane < lanes; lane += 1) inFlight.add(worker())
        await Promise.all(inFlight)
        if (firstError !== undefined) throw firstError

        return {
          api: 'typesafe',
          provider: options.provider,
          model: reportedModel ?? options.model,
          answers: normalizeAnswers(questions, merged),
          usage: { inputTokens, outputTokens },
        }
      } finally {
        cancel()
      }
    },
  }
}
