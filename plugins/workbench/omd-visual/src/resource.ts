/**
 * The `visual` internal path source.
 *
 * `dsh-resource://visual/<sessionId>/<targetSeq>` names one record by the
 * assistant message it decorates, so a human or an agent can read back the
 * fence, who asked for it, and where the child ran, long after the card
 * scrolled away. Only live sessions are addressable: a record is a fact about a
 * session this process holds, and inventing a cold-storage reader for it would
 * be a second source of truth.
 *
 * @module omd-visual/resource
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

import { latestVisualRecord } from './record.ts'
import type { InternalPathFace, VisualRecordPayload } from './types.ts'

/** The address a source read receives. */
export const GRAMMAR = 'dsh-resource://visual/<sessionId>/<targetSeq>'

/** The part of `ctx.sessions` this source reads. */
interface SessionFace {
  get(id: SessionId): Session | undefined
}

/**
 * Parse `<sessionId>/<targetSeq>`.
 * @param path - address remainder after `dsh-resource://visual/`.
 * @param address - the full address, quoted in errors.
 * @returns both segments.
 * @throws when the path is not the two-segment form.
 */
function parse(path: string, address: string): { sessionId: string; targetSeq: number } {
  const segments = path.trim().replace(/^\/+/u, '').split('/')
  if (segments.length !== 2) {
    throw new Error(`cannot read "${address}": expected ${GRAMMAR}`)
  }
  const [sessionId, rawSeq] = segments as [string, string]
  if (sessionId === '') throw new Error(`cannot read "${address}": name a session id before the sequence number`)
  if (!/^\d+$/u.test(rawSeq)) {
    throw new Error(`cannot read "${address}": ${JSON.stringify(rawSeq)} is not a sequence number`)
  }
  return { sessionId, targetSeq: Number(rawSeq) }
}

/**
 * Render one record as text a reader can copy the fence out of.
 * @param record - the stored payload.
 * @returns the record's metadata followed by its fence.
 */
function render(record: VisualRecordPayload): string {
  const lines = [
    `# visual ${record.sessionId}/${record.targetSeq}`,
    '',
    `status: ${record.status}`,
    `turn ${record.turn}, step ${record.step}`,
    `address: ${record.props.address}`,
    `requested by: ${record.decidedBy.role}`,
    ...record.reason === undefined ? [] : [`reason: ${record.reason}`],
    ...record.props.title === undefined ? [] : [`title: ${record.props.title}`],
    ...record.props.childSessionId === undefined
      ? []
      : [`child: ${record.props.childSessionId} (${record.props.childMode ?? 'unknown'})`],
    ...record.props.fallback === undefined ? [] : ['', record.props.fallback],
  ]
  if (record.props.fence === undefined) return lines.join('\n')
  return [...lines, '', record.props.fence].join('\n')
}

/**
 * Register the source for the plugin's lifetime.
 * @param ctx - plugin context; the registry is reached through `inject` so the
 *   package stays optional.
 */
export function registerVisualSource(ctx: Context): void {
  ctx.inject(['internalPaths'], (scope) => {
    const registry = scope.get('internalPaths') as InternalPathFace | undefined
    if (registry === undefined) return
    scope.effect(() => registry.register('visual', {
      grammar: GRAMMAR,
      description: 'Visualization records produced by omd-visual: status, fence, title, and child session per drawn component.',
      shorthand: false,
      live: false,
      read: async (path) => {
        const address = `dsh-resource://visual/${path}`
        const { sessionId, targetSeq } = parse(path, address)
        const sessions = scope.get('sessions') as SessionFace | undefined
        const session = sessions?.get(SessionId(sessionId))
        if (session === undefined) {
          throw new Error(`cannot read "${address}": no live session ${JSON.stringify(sessionId)}`)
        }
        const record = latestVisualRecord(session.snapshotEvents(), targetSeq)
        if (record === undefined) {
          throw new Error(`cannot read "${address}": this session holds no visualization record for event ${targetSeq}`)
        }
        return render(record)
      },
    }), 'omd-visual: dsh-resource://visual')
  })
}
