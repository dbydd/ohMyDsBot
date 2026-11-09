/**
 * Wire shapes of `dsh-resource://agents/<sessionId>` and the structural faces
 * this host-only plugin reads from other services.
 *
 * Every optional fact is `null` rather than absent or guessed: the browser
 * panel renders the same field set for every row.
 *
 * @module omd-agents-live/types
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** Lifecycle of one delegated child as this process can prove it. */
export type AgentLiveStatus = 'running' | 'settled' | 'completed' | 'failed' | 'cancelled'

/** What the child is doing right now, in one line. */
export type AgentLiveActivityKind = 'tool' | 'text' | 'thinking'

/** One line of "now what". */
export interface AgentLiveActivity {
  /** A tool call, visible assistant text, or reasoning that produced no text. */
  readonly kind: AgentLiveActivityKind
  /** The rendered one-line summary, clipped by the tracker to the configured `activityMaxChars` (default 80). */
  readonly label: string
}

/** One extracted metric; see `extractMetrics`. */
export interface MetricEntry {
  /** The metric's name exactly as logged (`mpsnr`, `train/loss`). */
  readonly label: string
  /** Numeric value; never a string copy of the log. */
  readonly value: number
  /** Short unit token when the log wrote one (`dB`, `%`, `k`), else `null`. */
  readonly unit: string | null
  /** Signed change from the trailing `▲/▼/±` marker, else `null`. */
  readonly delta: number | null
}

/** The one metric worth putting on the ticker line. */
export interface HeadlineEntry {
  /** The value as written, with its unit (`40.20 dB`). */
  readonly label: string
  /** Signed change behind the headline value. */
  readonly delta: number
  /** Context phrase found nearby (`best @ iter 10.0k`), else `null`. */
  readonly note: string | null
}

/** One child row; every value is a fact this host read, or `null`. */
export interface AgentLiveEntry {
  /** Child session id. */
  readonly id: string
  /** Catalog label, the child's descriptor label, or the first 8 id characters. */
  readonly name: string
  readonly status: AgentLiveStatus
  /** Durable creation time from the parent's catalog row, or the first own event time. */
  readonly startedAt: number | null
  /** Milliseconds since `startedAt` while running; frozen at the last own event once ended. */
  readonly elapsedMs: number | null
  readonly activity: AgentLiveActivity | null
  /** `provider/model` of the child's latest assistant message. */
  readonly model: string | null
  /** Sum of the child's reported token usage. */
  readonly tokens: number | null
  /** Tool calls the child issued since its own log suffix began. */
  readonly toolCalls: number | null
  /** Heuristic metrics from the last 40 lines of the latest result/message. */
  readonly metrics: MetricEntry[] | null
  readonly headline: HeadlineEntry | null
}

/** One background job owned by the addressed session. */
export interface JobLiveEntry {
  readonly id: string
  /** Producer kind exactly as the registry recorded it (`bash`, …). */
  readonly kind: string
  /** Producer label (the command line). */
  readonly label: string
  /** Registry status word: `running`, `stopping`, `completed`, `killed`, `failed`. */
  readonly status: string
  readonly startedAt: number | null
  readonly elapsedMs: number | null
  /** Heuristic metrics from the last 40 lines of the retained output tail. */
  readonly metrics: MetricEntry[] | null
  readonly headline: HeadlineEntry | null
}

/** The whole document one read returns. */
export interface AgentsLiveSnapshot {
  readonly sessionId: string
  /** Epoch ms of this read; the client's clock anchor for `elapsedMs`. */
  readonly generatedAt: number
  readonly agents: AgentLiveEntry[]
  readonly jobs: JobLiveEntry[]
}

/** The part of `ctx.internalPaths` this package registers into. */
export interface InternalPathRegistry {
  register(source: string, provider: {
    readonly grammar: string
    readonly shorthand?: boolean
    readonly live?: boolean
    read(path: string, exec: { readonly signal?: AbortSignal }): Promise<string | Uint8Array>
  }): () => void
}

/** The part of `ctx.sessions` this package reads. */
export interface SessionStoreFace {
  get(id: SessionId): Session | undefined
}

/** The part of `ctx.agents` this package reads. */
export interface LiveAgentsFace {
  get(id: SessionId): { readonly status?: unknown } | undefined
}

/** The part of `ctx.sessionProjections` this package reads. */
export interface ProjectionReader {
  stateOf(session: Session, key: string): unknown
}

/** One job projection; see `@deepseek-ai/dsh-jobs/view`. */
export interface JobViewFace {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly owner?: string
  readonly status: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly output: {
    readonly total: number
    readonly earliest: number
  }
}

/** One non-consuming output read; see `JobRegistry.readAt`. */
export interface JobOutputReadFace {
  readonly chunks: readonly { readonly text: string }[]
  readonly next: number
}

/** The part of `ctx.jobs` this package reads. */
export interface JobsFace {
  list(caller?: SessionId): readonly JobViewFace[]
  readAt(id: string, from: number, caller?: SessionId): JobOutputReadFace
}
