/**
 * Data shapes of `omd-visual`: the `plugin:omd/visual` session record, plus the
 * structural faces of the host services this plugin reaches through
 * `agent.ctx.get(...)`.
 *
 * The faces are declared here rather than imported so the package keeps one
 * runtime edge (`@deepseek-ai/dsh-session`) and no peer edge to the subagent,
 * tool, or prompt packages: a profile without one of them still loads, and the
 * absence is reported at the call site instead of failing activation.
 *
 * @module omd-visual/types
 */

/** One text or non-text block of child output, as the subagent service returns it. */
export type SubagentOutputBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: string; readonly [key: string]: unknown }

/** Why a child run ended; anything but `completed` means its output may be partial. */
export type SubagentStopReason = string

/** One text block of the child's brief; the brief is always one plain user message. */
export interface PromptBlock {
  readonly type: 'text'
  readonly text: string
}

/** The terminal outcome of one child run. */
export interface SubagentResult {
  /** The child's final assistant output. */
  readonly output: readonly SubagentOutputBlock[]
  /** Why the run ended. */
  readonly stopReason: SubagentStopReason
  /** Provider-authored failure detail for a non-`completed` run. */
  readonly diagnostic?: string
}

/** One live child activation. */
export interface SubagentActivation {
  /** Stable identity of the child session. */
  readonly childId: string
  /** Settles when the child's turn is over; rejects only on an infrastructure fault. */
  readonly result: Promise<SubagentResult>
  /** Stop the child and release its slot. */
  dispose(): Promise<void>
}

/** What one activation asks the subagent manager for. */
export interface SubagentStartSpec {
  /** Registered backend name, `spawn`. */
  readonly provider: string
  /** Short label retained in the child catalog. */
  readonly label: string
  readonly request: {
    /** The spawning agent; omitting `agentPreset` joins its current generation. */
    readonly parent: unknown
    /** One user message carrying the brief. */
    readonly prompt: readonly PromptBlock[]
  }
  /** Cancellation for admission and for the running child. */
  readonly signal: AbortSignal
  /** `caller` keeps the settlement out of the parent's model history. */
  readonly delivery: 'caller'
}

/** The part of `ctx.subagents` this plugin uses. */
export interface SubagentFace {
  startActivation(spec: SubagentStartSpec): Promise<SubagentActivation>
}

/** The part of `agent.ctx.get('systemPrompt')` this plugin uses to shadow a section. */
export interface PromptFace {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string
    readonly interpolate?: boolean
  }): () => void
}

/** The part of `agent.ctx.get('tools')` this plugin uses to mask global tools. */
export interface ToolFace {
  /** Tools currently visible to one agent, used to deny only names that exist. */
  schemas(agent: unknown): readonly { readonly name: string }[]
  restrict(filter: { readonly deny: readonly string[] }): () => void
}

/** The part of `ctx.internalPaths` this plugin registers into. */
export interface InternalPathFace {
  register(source: string, provider: {
    readonly grammar: string
    readonly shorthand?: boolean
    readonly live?: boolean
    read(path: string, exec: unknown): Promise<string | Uint8Array>
  }): () => void
}

/** Who asked for the visualization. */
export interface VisualDecision {
  /** A human asked for it in the newest message. */
  readonly role: 'user'
}

/** Where one visualization stands. */
export type VisualStatus = 'pending' | 'ready' | 'failed' | 'timeout' | 'skipped'

/** One record's payload, beside the `targetSeq`-addressed props the client renders. */
export interface VisualRecordPayload {
  /** Session holding the decorated answer. */
  readonly sessionId: string
  /** Log sequence of the assistant message the card hangs under. */
  readonly targetSeq: number
  /** Turn that produced the answer; also gives the record its chat location. */
  readonly turn: number
  /** Step within the turn. */
  readonly step: number
  /** Renderer family; one string so a later visual kind can share the card. */
  readonly component: 'visual'
  /** Lifecycle of this record. The newest record for one `targetSeq` wins. */
  readonly status: VisualStatus
  /** Who caused the attempt. */
  readonly decidedBy: VisualDecision
  /** Why the record is in this state; free text, read by the status card. */
  readonly reason?: string
  /** What the client renders. */
  readonly props: VisualRecordProps
  /** Epoch milliseconds when the record was written. */
  readonly at: number
}

/** The rendering half of one record. */
export interface VisualRecordProps {
  /** Raw fence text, markers included; absent unless `status` is `ready`. */
  readonly fence?: string
  /** Title the child chose, when its document carries one. */
  readonly title?: string
  /** Text summary the child supplied as the document's fallback. */
  readonly fallback?: string
  /** `dsh-resource://visual/<sessionId>/<targetSeq>` for this record. */
  readonly address: string
  /** Child session that produced the fence, when the spawn got that far. */
  readonly childSessionId?: string
  /** How to open that child's own session. */
  readonly childMode?: 'continuable' | 'one-shot' | 'unknown'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /**
     * One visualization attempt for one assistant message.
     *
     * `ignorable`, so no reader is required to understand it; a reader that does
     * not is expected to retain and skip the record. The newest record for a
     * `targetSeq` replaces the earlier ones when the client folds the log, which
     * is how `pending` becomes `ready` or `failed` without a second event type.
     */
    'plugin:omd/visual': VisualRecordPayload
  }
}
