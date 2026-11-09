/**
 * The ONE home of the `omdAgents` projection-key merges, re-exporting the
 * roster shapes so a client aggregate can type a panel without importing this
 * package's host-side value module.
 *
 * @module omd-agents-hub/types
 */

import type { OmdAgentRoster, OmdAgentsState } from './fold.ts'

export type {
  OmdAgentIsolation,
  OmdAgentRecord,
  OmdAgentRoster,
  OmdAgentStatus,
} from './fold.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host fold state of the delegated-child roster; the wire view is its `agents` map. */
    omdAgents: OmdAgentsState
  }

  interface SessionProjectionMap {
    /**
     * Every child this session delegated to, keyed by child session id, with
     * `null` in each field the parent's log cannot prove.
     */
    omdAgents: OmdAgentRoster
  }
}
