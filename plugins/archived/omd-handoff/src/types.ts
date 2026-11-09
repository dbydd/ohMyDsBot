/**
 * Merge the `handoff` projection key into the harness vocabulary and hold the
 * shapes shared by the fold, the command, and the document builder.
 *
 * Durability, stated once: `handoff` is a host-only fold whose only input is
 * a successful `command/done` whose text carries the four document headings.
 * An out-of-tree plugin cannot declare a session event type
 * (`packages/core/session/src/known-event-types.ts:8-21`), and `command/done`
 * carries neither `name` nor `args`, so the heading check is the identity.
 *
 * @module omd-handoff/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { ZodType } from 'zod'

/**
 * One generated handoff document and when it was produced; `null` before the
 * session's first handoff. This is the shape the contract fixes for the key.
 */
export type HandoffState = {
  /** Complete document body. */
  readonly body: string
  /** Epoch milliseconds of the producing `command/done`. */
  readonly at: number
} | null

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest structured handoff document of this session, host-only. */
    handoff: HandoffState

    /**
     * `@deepseek-ai/dsh-tool-todo`'s whole-list fold, read here.
     *
     * That package is not on this package's runtime link path, so its own
     * declaration is not part of this program. The shape below is the subset
     * this package reads; it merges with the owner's declaration only in a
     * program that composes the two, which per-package compilation avoids.
     */
    todos: readonly TodoEntry[] | null

    /**
     * `@deepseek-ai/dsh-goal`'s current-goal fold, read here.
     *
     * Same reasoning as `todos`: only the objective and phase are read, and a
     * session without a goal carries `current: null`.
     */
    goal: { readonly current: { readonly goal: { readonly objective: string; readonly phase: string } } | null }
  }
}

/** Host fold schema; what the projection cache persists. */
export const handoffStateSchema: ZodType<HandoffState> = z.object({
  body: z.string(),
  at: z.number(),
}).nullable()

/** The four section headings every generated document carries, in this order. */
export const SECTION_HEADINGS: readonly string[] = Object.freeze([
  '## Objective',
  '## Progress',
  '## Decisions',
  '## Next steps',
])

/** Fixed outcome when the session has nothing to summarize yet. */
export const NOTHING_TO_HAND_OFF = 'Nothing to hand off (no messages yet)'

/** Fixed outcome while a response is still running or queued. */
export const WAIT_FOR_RESPONSE =
  'Wait for the current response to finish or abort it before handing off.'

/** One todo entry as the `todos` projection carries it. */
export interface TodoEntry {
  /** Short imperative line. */
  readonly content: string
  /** Lifecycle state. */
  readonly status: string
}

/** The `goal` projection's current value, reduced to what a handoff needs. */
export interface GoalEntry {
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: string
}

/** Everything the prompt builder reads from the session, all optional by composition. */
export interface HandoffInputs {
  /** Emphasis the user appended to the command, already trimmed; `''` when absent. */
  readonly focus: string
  /** Current goal, or `null` when the key is unregistered or no goal is set. */
  readonly goal: GoalEntry | null
  /** Current todo list, or `null` when the key is unregistered or never written. */
  readonly todos: readonly TodoEntry[] | null
  /** Rendered conversation transcript; the only input carrying the actual work. */
  readonly transcript: string
}

// ── human-command seam ───────────────────────────────────────────────────────
// Mirrored from `@deepseek-ai/dsh-commands/src/index.ts:41-78` and
// `src/types.ts:20-41`, which are not on this package's runtime link path. Only
// the fields this package reads and writes are declared, so the structural
// shape below is a subset of the real one and satisfies it wherever both meet.

/** One command invocation, as the registry hands it to a handler. */
export interface CommandInvocation {
  /** Exact agent whose UI received the command. */
  readonly agent: Agent
  /** Exact text following the command name, separator whitespace included. */
  readonly rawInput: string
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
}

/** Expected command outcome, rendered directly by the dispatching UI. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** One plugin-owned command registration. */
export interface CommandDefinition {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI; must not be empty. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: { readonly hint: string }
  /** Execute against the receiving agent without sending the command to the model. */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Human-command registry from `@deepseek-ai/dsh-commands`. */
    commands: { register(definition: CommandDefinition): () => void }
    /**
     * Host default model selection from `@deepseek-ai/dsh-agent-default-model`,
     * when that package is composed.
     *
     * Declared as the one method this package calls. The service is optional by
     * composition, so it is read with `ctx.get`, never as a required injection.
     */
    agentDefaultModel: DefaultModelService
  }
}

/** The single method a one-shot call needs from the host's default selection. */
export interface DefaultModelService {
  /**
   * Read the selection a fresh Agent would use.
   * @returns the provider route, the model id, and an optional reasoning effort.
   */
  currentSelection(): { provider: string; model: string }
}
