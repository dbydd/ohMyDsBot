/**
 * The `chart` internal path source.
 *
 * `dsh-resource://chart/<sessionId>/<anchorSeq>` names one chart record by the
 * assistant message it decorates, so an agent or a human can read back the kind,
 * the categories, the series values and the plan behind them without opening the
 * web UI. Only live sessions are addressable: a record is a fact about a session
 * this process holds.
 *
 * @module omd-table-chart/resource
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

import { allChartRecords, latestChartRecord } from './record.ts'
import type { ChartRecordPayload, InternalPathFace } from './types.ts'

/** The address a source read receives. */
export const GRAMMAR = 'dsh-resource://chart/<sessionId>/<anchorSeq>'

/** The part of `ctx.sessions` this source reads. */
interface SessionFace {
  get(id: SessionId): Session | undefined
}

/**
 * Parse `<sessionId>/<anchorSeq>`.
 * @param path - address remainder after `dsh-resource://chart/`.
 * @param address - the full address, quoted in errors.
 * @returns both segments.
 * @throws when the path is not the two-segment form.
 */
function parse(path: string, address: string): { sessionId: string; anchorSeq: number } {
  const segments = path.trim().replace(/^\/+/u, '').split('/')
  if (segments.length !== 2) {
    throw new Error(`cannot read "${address}": expected ${GRAMMAR}`)
  }
  const [sessionId, rawSeq] = segments as [string, string]
  if (sessionId === '') throw new Error(`cannot read "${address}": name a session id before the sequence number`)
  if (!/^\d+$/u.test(rawSeq)) {
    throw new Error(`cannot read "${address}": ${JSON.stringify(rawSeq)} is not a sequence number`)
  }
  return { sessionId, anchorSeq: Number(rawSeq) }
}

/** One series as a line a reader can compare with the table. */
function seriesLine(entry: ChartRecordPayload['spec']['series'][number]): string {
  const values = entry.values.map(value => value === null ? '—' : String(value)).join(', ')
  return `- ${entry.header} [${entry.dim}]: ${values}`
}

/**
 * Render one record as the spec plus the plan it came from.
 * @param record - the stored payload.
 * @returns the record's summary, its series, and the spec as JSON.
 */
function render(record: ChartRecordPayload): string {
  const { spec, plan, decidedBy, trace } = record
  const focused = spec.focus
    .map(index => spec.categories[index])
    .filter((name): name is string => name !== undefined)
  const decStr =
    decidedBy.role === 'judge'
      ? `judge (${decidedBy.provider}/${decidedBy.model}${decidedBy.api ? `, api: ${decidedBy.api}` : ''})`
      : 'heuristic'
  const lines = [
    `# chart ${record.sessionId}/${record.anchorSeq}`,
    '',
    `anchor: seq ${record.anchorSeq} (turn ${record.turn}, step ${record.step})`,
    `decided by: ${decStr}`,
    `kind: ${spec.kind}`,
    ...spec.title === undefined ? [] : [`title: ${spec.title}`],
    `order: ${spec.order ?? 'table order'}`,
    `rivals: ${spec.rivals ?? 'unspecified'}`,
    ...focused.length === 0 ? [] : [`focus: ${focused.join(', ')}`],
    `categories (${spec.categories.length}): ${spec.categories.join(', ')}`,
    ...Object.keys(spec.polarity).length === 0
      ? []
      : [`polarity: ${Object.entries(spec.polarity).map(([header, side]) => `${header}=${side}`).join(', ')}`],
    '',
    '## series',
    ...spec.series.map(seriesLine),
    ...spec.whole === undefined ? [] : ['', '## whole', seriesLine(spec.whole)],
    '',
    ...trace === undefined
      ? []
      : [
          '## trace',
          `- adopted (${trace.adopted.length}): ${trace.adopted.join(', ') || 'none'}`,
          `- ignored (${trace.ignored.length}): ${trace.ignored.join(', ') || 'none'}`,
          '',
          '| question | adopted | reason | before | after | conf / gate |',
          '|---|---|---|---|---|---|',
          ...trace.entries.map(e =>
            `| ${e.id} | ${e.adopted ? 'yes' : 'no'} | ${e.reason} | ${e.before ?? '—'} | ${e.after ?? '—'} | ${e.confidence !== undefined ? e.confidence.toFixed(2) : '—'} / ${e.threshold.toFixed(2)} |`
          ),
          '',
        ],
    '',
    '## plan',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    '',
    '## spec',
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
  ]
  return lines.join('\n')
}

/**
 * Register the source for the plugin's lifetime.
 * @param ctx - plugin context; the registry is reached through `inject` so the
 *   package stays optional.
 */
export function registerChartSource(ctx: Context): void {
  ctx.inject(['internalPaths'], (scope) => {
    const registry = scope.get('internalPaths') as InternalPathFace | undefined
    if (registry === undefined) return
    scope.effect(() => registry.register('chart', {
      grammar: GRAMMAR,
      description: 'Chart plans recorded by omd-table-chart: kind, categories, series, and focus for one drawn table.',
      shorthand: false,
      live: false,
      read: async (path) => {
        const address = `dsh-resource://chart/${path}`
        const raw = path.trim().replace(/^\/+/u, '')
        // If path is just sessionId, render directory list of available charts:
        if (!raw.includes('/')) {
          const sessions = scope.get('sessions') as SessionFace | undefined
          const session = sessions?.get(SessionId(raw))
          if (session === undefined) {
            throw new Error(`cannot read "${address}": no live session ${JSON.stringify(raw)}`)
          }
          const records = allChartRecords(session.snapshotEvents())
          const lines = [
            `# charts in session ${raw}`,
            '',
            ...records.map(r => `- dsh-resource://chart/${raw}/${r.anchorSeq} (turn ${r.turn}, kind: ${r.spec.kind}, decided by: ${r.decidedBy.role})`),
          ]
          return lines.join('\n')
        }
        const { sessionId, anchorSeq } = parse(path, address)
        const sessions = scope.get('sessions') as SessionFace | undefined
        const session = sessions?.get(SessionId(sessionId))
        if (session === undefined) {
          throw new Error(`cannot read "${address}": no live session ${JSON.stringify(sessionId)}`)
        }
        const record = latestChartRecord(session.snapshotEvents(), anchorSeq)
        if (record === undefined) {
          throw new Error(`cannot read "${address}": this session holds no chart for event ${anchorSeq}`)
        }
        return render(record)
      },
    }), 'omd-table-chart: dsh-resource://chart')
  })
}
