/**
 * Pure types of the plan-gate domain: a read-only mirror of the `plan`
 * projection key owned by `@deepseek-ai/dsh-plan-mode`, plus the exit
 * handoff modes. No host-side value imports, so this module never pulls the
 * plan-mode package into this tree-out plugin's dependency set.
 *
 * @module omd-plan-gate/types
 */

/**
 * Host fold state of the `plan` projection. Mirrors
 * `@deepseek-ai/dsh-plan-mode/types` `PlanUnitState` field for field so
 * `ctx.sessionProjections.stateOf(session, 'plan')` can be typed here without
 * importing the plan-mode package itself.
 */
export interface PlanUnitState {
  /** Logged plan mode: the last `plan/mode`, inactive before the first. */
  active: boolean
  /** The selection's target mode; null when no selection is outstanding. */
  wanted: boolean | null
  /** The latest plan command awaiting its paired settlement. */
  running: { commandId: string; wanted: boolean } | null
  /** Active state recorded by the latest `request/header`, or null. */
  activeAtLastHeader: boolean | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Plan collaboration state folded by `@deepseek-ai/dsh-plan-mode`; mirrored read-only here. */
    plan: PlanUnitState
  }
}

/** Handoff strategy chosen when leaving plan mode. */
export type ExitMode = 'execute' | 'compact' | 'keep'
