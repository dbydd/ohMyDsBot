/**
 * `omd-memory-observe` — the session transcript the memory backend reads.
 *
 * dsh forbids reading session history synchronously (`Session.eventAt`,
 * `snapshotEvents`, `ownEvents`) and gives plugins no cursor event to write, so
 * this package owns both halves of the substitute: a `memoryObservation`
 * session projection that folds committed events into turns, and the read model
 * a consumer uses instead of touching the log.
 *
 * The boundary is deliberately narrow. Consumers get cleaned segments for
 * completed turns, the open (pending) turn, and the watermark `throughSeq` —
 * never the log, never a fold hook. A consumer that needs a different view
 * extends `src/fold.ts` here; it does not read the session itself.
 *
 * Nothing here is model-visible: no tool, no prompt section, no injection. The
 * package exists so that another package can decide what to remember.
 *
 * @module omd-memory-observe
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import {
  foldObservation,
  initialObservation,
  latestTurn,
  observationStateSchema,
  pendingTurn,
} from './fold.ts'
import type {
  CommittedTurn,
  ObservationBounds,
  ObservationState,
  PendingTurn,
} from './fold.ts'

export type {
  AssistantSegment,
  CommittedTurn,
  ObservationBounds,
  ObservationState,
  ObservedSegment,
  PendingTurn,
  SegmentBase,
  ToolSegment,
  UserSegment,
} from './fold.ts'
export type { RetainedSource, RetainedSourceKind } from './sources.ts'

/** The projection key this package owns. */
export const MEMORY_OBSERVATION = 'memoryObservation'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded turns of the session transcript, bounded in turns and characters. */
    memoryObservation: ObservationState
  }
}

/** Plugin id the Loader entry carries. */
export const name = 'omd-memory-observe'

/** The projection registry is the package's whole input. */
export const inject = ['sessionProjections']

/** Deployment settings for the fold. */
export interface Config {
  /** Completed turns kept for recent-context reads. */
  turnWindow: number
  /** Characters kept in the open turn; its oldest segments are dropped beyond it. */
  maxChars: number
  /** Characters kept in one segment, including a tool call's compact action line. */
  maxSegmentChars: number
}

/** Schemastery configuration for the fold. */
export const Config: z<Config> = z.object({
  turnWindow: z.natural().default(4)
    .description('Completed turns kept for recent-context reads.'),
  maxChars: z.number().step(1).min(1).default(20000)
    .description('Characters kept in the open turn; the oldest segments are dropped beyond this bound.'),
  maxSegmentChars: z.number().step(1).min(1).default(4000)
    .description('Characters kept in one segment, including a tool call\'s compact action line.'),
})

/** Called once per turn the log closes, after the fold has committed it. */
export type TurnCommitListener = (turn: CommittedTurn, session: Session) => void

/**
 * The read model consumers hold as `ctx.memoryObservation`.
 *
 * Every method throws when the projection is not registered in the calling
 * context: a consumer that lost its producer must fail where it reads, not
 * observe an empty transcript and enqueue blank memories.
 */
export interface MemoryObservation {
  /**
   * The open turn as it stands now.
   * @param session - the session whose log is being observed.
   * @returns the pending turn, or `null` when no turn is open.
   */
  pending(session: Session): PendingTurn | null
  /**
   * The committed turns still inside the configured window, oldest first.
   * @param session - the session whose log is being observed.
   * @returns the committed turns.
   */
  turns(session: Session): readonly CommittedTurn[]
  /**
   * The most recently committed turn.
   * @param session - the session whose log is being observed.
   * @returns that turn, or `null` before the first commit.
   */
  latest(session: Session): CommittedTurn | null
  /**
   * The seq of the last committed `turn/end`; the retain cursor's floor.
   * @param session - the session whose log is being observed.
   * @returns the watermark, `-1` before the first commit.
   */
  throughSeq(session: Session): number
  /**
   * Observe every turn this package commits, for the lifetime of the returned
   * disposer. A listener therefore sees each turn once, in log order.
   * @param listener - called with the committed turn and its session.
   * @returns the disposer that removes the listener.
   */
  subscribe(listener: TurnCommitListener): () => void
}

/**
 * Register the projection and publish the read model.
 * @param ctx - plugin context carrying the projection registry.
 * @param config - fold bounds from the profile row.
 */
export function apply(ctx: Context, config: Config): void {
  const bounds: ObservationBounds = {
    turnWindow: config.turnWindow,
    maxChars: config.maxChars,
    maxSegmentChars: Math.min(config.maxSegmentChars, config.maxChars),
  }

  ctx.sessionProjections.register<'memoryObservation', ObservationState>({
    key: MEMORY_OBSERVATION,
    stateVersion: 1,
    stateSchema: observationStateSchema,
    init: initialObservation,
    apply: (state, event) => foldObservation(state, event, bounds),
  })

  const listeners = new Set<TurnCommitListener>()
  const published = new WeakMap<Session, number>()

  /**
   * Read the fold state for one session, failing loudly when this package's
   * unit is absent from the registry.
   * @param session - the session to read.
   * @returns its current observation state.
   */
  const stateOf = (session: Session): ObservationState => {
    const state = ctx.sessionProjections.stateOf(session, MEMORY_OBSERVATION)
    if (state === undefined) {
      throw new Error(
        'omd-memory-observe: the memoryObservation projection is not registered in this context',
      )
    }
    return state
  }

  ctx.provide('memoryObservation', {
    pending: session => pendingTurn(stateOf(session)),
    turns: session => stateOf(session).committed,
    latest: session => latestTurn(stateOf(session)),
    throughSeq: session => stateOf(session).throughSeq,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  } satisfies MemoryObservation)

  // The registry registers its own `session/event` listener when the service is
  // constructed, so by the time this plugin activates — it injects that
  // service — the fold is already driven first. The `throughSeq` branch below
  // covers the opposite order anyway, so publication never depends on it.
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type !== 'turn/end') return
    if ((published.get(session) ?? -1) >= event.seq) return
    const state = ctx.sessionProjections.stateOf(session, MEMORY_OBSERVATION)
    if (state === undefined) return
    const folded = state.throughSeq >= event.seq
      ? state
      : foldObservation(state, event, bounds)
    const committed = folded.committed.findLast(turn => turn.throughSeq === event.seq)
    // A close for a turn this log never opened commits nothing.
    if (committed === undefined) return
    published.set(session, event.seq)
    for (const listener of [...listeners]) listener(committed, session)
  })

  ctx.effect(() => () => {
    listeners.clear()
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Folded session transcript published by `omd-memory-observe`. */
    memoryObservation: MemoryObservation
  }
}
