/**
 * The deferred-diagnostics queue: work a slow language server produced too late
 * to ride the tool result.
 *
 * A slow server must never cost the model a blocked tool call. A result that
 * would take twelve seconds is worth nothing at the moment the edit lands; the
 * model has already moved on, or worse, waited. So the fast path takes two
 * seconds, and whatever arrives later is parked here and delivered into the next
 * admitted step as injected context.
 *
 * Two rules keep the queue honest:
 *
 *  - **Freshness wins over completeness.** A newer write to the same file
 *    supersedes every pending entry for it: reporting the diagnostics of a
 *    superseded intermediate state describes a file that no longer exists.
 *  - **Nothing outlives its agent.** Entries are keyed by agent, delivered once,
 *    and cleared by the plugin-level disposer, so a hot unmount cannot leave a
 *    pending entry behind.
 *
 * @module omd-lsp-writethrough/deferred
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** One ready late result, rendered to the text the model will read. */
export interface DeferredNotice {
  /** The rendered `<system-notice>` body; never empty. */
  readonly text: string
}

/** The callback a background fetch uses to publish its rendered notice, or `undefined` for none. */
export type DeferredPublish = (notice: DeferredNotice | undefined) => void

/** One parked file slot: which write claimed it, whether its result has landed, and the text. */
interface Slot {
  readonly token: string
  ready: DeferredNotice | undefined
}

/**
 * Agent-keyed store of late results.
 *
 * A slot is claimed per `(agent, file)` with the write's token. Claiming a slot
 * that an older write still holds drops the older result — the caller that
 * published into it learns it lost the race and injects nothing. A landing
 * result only fills a slot whose token still matches; delivery then takes the
 * ready slots for one agent and leaves unsettled ones in place.
 */
export class DeferredDiagnostics {
  private readonly slots = new Map<Agent, Map<string, Slot>>()

  /**
   * Claim a file slot for one write, superseding any older claim on that file.
   *
   * @param agent - the agent that issued the write.
   * @param file - the path the write targeted.
   * @param token - this write's identity, distinct per write of the same path.
   * @returns the publisher this fetch reports through; publishing `undefined` clears the claim.
   */
  register(agent: Agent, file: string, token: string): DeferredPublish {
    let byFile = this.slots.get(agent)
    if (byFile === undefined) {
      byFile = new Map()
      this.slots.set(agent, byFile)
    }
    byFile.set(file, { token, ready: undefined })
    return (notice) => {
      const live = this.slots.get(agent)?.get(file)
      if (live === undefined || live.token !== token) return
      if (notice === undefined) {
        this.slots.get(agent)?.delete(file)
        return
      }
      live.ready = notice
    }
  }

  /**
   * Take every settled notice queued for one agent.
   *
   * Unsettled slots stay where they are: their fetch is still running and may
   * land before the step after this one. Settled slots are removed as they are
   * returned, so a notice is never delivered twice.
   *
   * @param agent - the agent whose ready notices to take.
   * @returns the notices, in the order their files were claimed.
   */
  take(agent: Agent): DeferredNotice[] {
    const byFile = this.slots.get(agent)
    if (byFile === undefined) return []
    const notices: DeferredNotice[] = []
    for (const [file, slot] of byFile) {
      if (slot.ready === undefined) continue
      notices.push(slot.ready)
      byFile.delete(file)
    }
    if (byFile.size === 0) this.slots.delete(agent)
    return notices
  }

  /**
   * Drop every pending slot. Called from the plugin's disposer.
   * @returns nothing.
   */
  clear(): void {
    this.slots.clear()
  }
}
