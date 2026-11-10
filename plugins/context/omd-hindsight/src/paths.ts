/**
 * The `hindsight` internal-path source: every piece of state addressable at
 * `dsh-resource://hindsight/<path>` and `hindsight://<path>`.
 *
 * Reads via the core HindsightHttpClient and renders via core render.ts.
 *
 * @module omd-hindsight/paths
 */

import type { ResolvedConfig } from './config.ts'
import type { BankConfig } from './core/types.ts'
import { matchPath } from './core/paths.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  describeMentalModelState,
  renderChunk,
  renderChunkList,
  renderDocument,
  renderDocumentList,
  renderKnowledgePage,
  renderMemory,
  renderMentalModel,
  renderOperation,
  renderQueue,
  renderQueueEntry,
} from './core/render.ts'
import { HindsightRequestError } from './core/client.ts'
import { backingMentalModelId } from './core/ops.ts'
import { getRuntime, type HindsightRuntime } from './runtime.ts'

export const GRAMMAR =
  'hindsight://[plugin/{config,status,project-config,queue,operations}|<bank>[/{facts|knowledge-base|mental-models|operations|stats}[/<id>]]] — memory banks, their contents, ops views, and the plugin status/config/queue JSON resources'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function bankOf(runtime: HindsightRuntime, bankId: string): BankConfig | undefined {
  return runtime.bank(bankId)
}

async function pendingBuildForPage(runtime: HindsightRuntime, bank: BankConfig, pageId: string): Promise<string | null> {
  try {
    const mentalModelId = await backingMentalModelId(runtime.client, bank.bankId, pageId)
    if (mentalModelId === null) return null
    const list = await runtime.client.listOperations(bank.bankId, {
      status: 'processing',
      type: 'refresh_mental_model',
      limit: 50,
    })
    const found = list.operations.find(op => op.mental_model_id === mentalModelId)
    return found ? found.id : null
  } catch {
    return null
  }
}

async function renderRoot(runtime: HindsightRuntime, config: ResolvedConfig): Promise<string> {
  const status = runtime.status
  const lines = [
    '# Hindsight banks',
    '',
    `- Status: ${status.healthy ? `healthy (${status.version ?? 'version unknown'})` : `degraded (${status.error ?? 'unprobed'})`}`,
    `- baseUrl: ${runtime.config.baseUrl}`,
    '',
    '## Banks',
    '',
  ]
  if (config.banks.length === 0) {
    lines.push('_No banks configured._')
  }
  for (const bank of config.banks) {
    lines.push(
      `### ${bank.id} (${bank.access}, retain ${bank.retain.mode})`,
      bank.description ?? '',
      `- Facts: \`hindsight://${bank.id}/facts?q=<query>\``,
      `- Knowledge base: \`hindsight://${bank.id}/knowledge-base\``,
      `- Mental models: \`hindsight://${bank.id}/mental-models\``,
      `- Operations: \`hindsight://${bank.id}/operations\``,
      '',
    )
  }
  lines.push('Read `hindsight://<bank>` for a bank overview; recall/retain through the `hindsight` tool.')
  return lines.join('\n')
}

function renderPluginConfig(config: ResolvedConfig): string {
  return [
    '# hindsight plugin config',
    '',
    `baseUrl: ${config.baseUrl}`,
    `defaultBank: ${config.defaultBank}`,
    `judgeAmbiguousConfidence: ${config.judgeAmbiguousConfidence}`,
    `recallMaxItems: ${config.recallMaxItems}`,
    'banks:',
    ...config.banks.map(bank =>
      `  - ${bank.id} (${bank.bankId}): access=${bank.access} retain=${bank.retain.mode} autoTarget=${bank.retain.autoTarget} — ${bank.description ?? '(no description)'}`,
    ),
  ].join('\n')
}

function renderPluginOperations(runtime: HindsightRuntime): string {
  const ops = runtime.operations()
  if (ops.length === 0) return '# hindsight tool runs\n\n(none in this process yet)'
  return [
    `# hindsight tool runs in this process (last ${Math.min(ops.length, 50)} of ${ops.length})`,
    '',
    ...ops.slice(-50).map(op =>
      `- #${op.seq} · ${op.at} · ${op.status} · actions: [${op.actions.join(', ')}]${op.hint ? ` · hint: ${op.hint}` : ''}${op.role ? ` · role: ${op.role}` : ''}`,
    ),
  ].join('\n')
}

async function renderBankOverview(runtime: HindsightRuntime, bank: BankConfig): Promise<string> {
  return [
    `# Bank: ${bank.id}`,
    '',
    `- bankId: \`${bank.bankId}\``,
    `- access: ${bank.access}; retain: ${bank.retain.mode}`,
    `- description: ${bank.description ?? '(none)'}`,
    '',
    '## Resources',
    '',
    `- Documents: \`hindsight://${bank.id}/documents\``,
    `- Knowledge base: \`hindsight://${bank.id}/knowledge-base\``,
    `- Mental models: \`hindsight://${bank.id}/mental-models\``,
    `- Facts query: \`hindsight://${bank.id}/facts?q=<query>\``,
    `- Operations log: \`hindsight://${bank.id}/operations\``,
    `- Stats: \`hindsight://${bank.id}/stats\``,
  ].join('\n')
}

/** Per-execution hooks: project-level config overrides resolved against the caller's cwd. */
export interface PathReaderHooks {
  /** Runtime serving the calling session; the default runtime answers the rest. */
  runtimeFor?(exec: PathExec): HindsightRuntime | undefined
  /** Effective config for the calling session's project directory. */
  configFor?(exec: PathExec): ResolvedConfig | undefined | Promise<ResolvedConfig | undefined>
  /** JSON document behind `plugin/project-config` for the calling session's project. */
  projectConfigDocument?(exec: PathExec): Promise<string>
}

/** The calling execution: an internal-path read carries the session, its cwd and the human/model origin. */
export interface PathExec {
  readonly cwd?: string
  readonly sessionId?: string
  readonly origin?: string
  readonly agent?: Agent
}

export function createPathReader(
  config: ResolvedConfig,
  runtimeGetter: () => HindsightRuntime | undefined,
  hooks?: PathReaderHooks,
) {
  return async (path: string, exec: PathExec = {}): Promise<string> => {
    const runtime = hooks?.runtimeFor?.(exec) ?? runtimeGetter() ?? getRuntime(exec.sessionId ?? exec.agent?.id)
    if (!runtime) throw new Error('Hindsight runtime not initialized')
    const effective = (await hooks?.configFor?.(exec)) ?? config
    runtime.configure({ config: effective.core, cwd: runtime.cwd })

    const raw = path.trim()
    const normalized = raw.startsWith('hindsight://') ? raw : `hindsight://${raw.replace(/^\/+/u, '')}`
    const matched = matchPath(normalized)

    if (matched === null) {
      if (raw === '' || raw === 'hindsight://') return renderRoot(runtime, effective)
      if (raw === 'plugin/config' || raw === 'hindsight://plugin/config') return renderPluginConfig(effective)
      if (raw === 'plugin/project-config' || raw === 'hindsight://plugin/project-config') {
        if (hooks?.projectConfigDocument === undefined) {
          throw new Error('cannot read "hindsight://plugin/project-config": project config store is not wired')
        }
        return await hooks.projectConfigDocument(exec)
      }
      if (raw === 'plugin/status' || raw === 'hindsight://plugin/status') {
        return JSON.stringify(await statusDocument(runtime, effective), null, 2) + '\n'
      }
      if (raw === 'plugin/queue' || raw === 'hindsight://plugin/queue') {
        return JSON.stringify(await runtime.queue.inspect(), null, 2) + '\n'
      }
      if (raw === 'plugin/operations' || raw === 'hindsight://plugin/operations') return renderPluginOperations(runtime)
      if (raw === 'queue' || raw === 'hindsight://queue') {
        return renderQueue(await runtime.queue.inspect())
      }
      throw new Error(`cannot read "${path}": unknown hindsight path`)
    }

    const { route, params, query } = matched
    const bankId = params.bank
    const bank = bankId ? bankOf(runtime, bankId) : undefined

    if (bankId && !bank) {
      throw new Error(`cannot read "${path}": no bank ${JSON.stringify(bankId)} — configured: ${[...effective.bankIds].join(', ')}`)
    }
    if (bankId && !effective.enabled) {
      throw new Error(`cannot read "${path}": hindsight is disabled for project ${JSON.stringify(exec.cwd ?? '(unknown)')}`)
    }

    switch (route.pattern) {
      case '':
        return renderRoot(runtime, effective)
      case ':bank':
        return renderBankOverview(runtime, bank!)
      case ':bank/documents': {
        const list = await runtime.client.listDocuments(bank!.bankId, {
          q: query.q,
          limit: query.limit ? Number(query.limit) : 50,
          offset: query.offset ? Number(query.offset) : 0,
        })
        return renderDocumentList({
          bank: bank!.id,
          items: list.items,
          total: list.total,
          limit: list.limit,
          offset: list.offset,
          q: query.q,
        })
      }
      case ':bank/documents/:doc': {
        const doc = await runtime.client.getDocument(bank!.bankId, params.doc ?? '')
        if (!doc) throw new Error(`document ${JSON.stringify(params.doc)} not found in bank ${bank!.id}`)
        return renderDocument({ bank: bank!.id, document: doc, localFile: null })
      }
      case ':bank/documents/:doc/chunks': {
        const chunks = await runtime.client.listDocumentChunks(bank!.bankId, params.doc ?? '', { limit: 100 })
        return renderChunkList({ bank: bank!.id, documentId: params.doc ?? '', chunks: chunks.items, total: chunks.total })
      }
      case ':bank/chunks/:id': {
        const chunk = await runtime.client.getChunk(params.id ?? '')
        return renderChunk({ bank: bank!.id, chunk })
      }
      case ':bank/facts': {
        const q = query.q
        if (!q || q.trim().length === 0) {
          return [
            `# Facts in ${bank!.id}`,
            '',
            'Provide a search query: `hindsight://' + bank!.id + '/facts?q=<keyword>`',
          ].join('\n')
        }
        const recall = await runtime.client.recall(bank!.bankId, q, {
          maxTokens: bank!.recall.maxTokens,
        })
        const lines = [
          `# Recall results: "${q}" in ${bank!.id} (${recall.results.length} matches)`,
          '',
          ...recall.results.map(r =>
            `- \`hindsight://${bank!.id}/facts/${r.id}\` (${r.type ?? 'unknown'}) ${preview(r.text, 160)}`,
          ),
        ]
        return lines.join('\n')
      }
      case ':bank/facts/:id': {
        const factId = params.id ?? ''
        if (!UUID_PATTERN.test(factId)) {
          // Keyword search fallback
          const recall = await runtime.client.recall(bank!.bankId, factId, { maxTokens: bank!.recall.maxTokens })
          return [
            `# Recall for "${factId}" in ${bank!.id}`,
            '',
            ...recall.results.map(r =>
              `- \`hindsight://${bank!.id}/facts/${r.id}\` (${r.type ?? 'unknown'}) ${preview(r.text, 160)}`,
            ),
          ].join('\n')
        }
        const mem = await runtime.client.getMemory(bank!.bankId, factId)
        if (!mem) throw new Error(`fact ${JSON.stringify(factId)} not found in bank ${bank!.id}`)
        return renderMemory({ bank: bank!.id, memory: mem })
      }
      case ':bank/knowledge-base': {
        const tree = await runtime.client.getKnowledgeBaseTree(bank!.bankId)
        const rows: string[] = []
        const walk = (nodes: typeof tree.roots, depth: number) => {
          for (const node of nodes) {
            const indent = '  '.repeat(depth)
            const isPage = node.kind === 'page'
            rows.push(`${indent}- ${isPage ? 'page' : 'folder'} \`${node.id}\`: ${node.name}`)
            if (isPage) rows.push(`${indent}  read: hindsight://${bank!.id}/knowledge-base/pages/${node.id}`)
            if (node.children) walk(node.children, depth + 1)
          }
        }
        walk(tree.roots, 0)
        return [`# Knowledge base: ${bank!.id}`, '', ...(rows.length === 0 ? ['(empty knowledge base)'] : rows)].join('\n')
      }
      case ':bank/knowledge-base/pages/:id': {
        const pageId = params.id ?? ''
        const page = await runtime.client.getKnowledgePage(bank!.bankId, pageId)
        const pendingOp = (page.body ?? '').trim().length > 0 ? null : await pendingBuildForPage(runtime, bank!, page.id)
        return renderKnowledgePage({ page, pendingOperationId: pendingOp })
      }
      case ':bank/mental-models': {
        const list = await runtime.client.listMentalModels(bank!.bankId, { limit: 100 })
        const rows = list.items.map(m =>
          `- \`${m.id}\`: ${m.name} (${describeMentalModelState(m, null)})\n  read: hindsight://${bank!.id}/mental-models/${m.id}`,
        )
        return [`# Mental models in ${bank!.id} (${list.items.length})`, '', ...(rows.length === 0 ? ['(no models)'] : rows)].join('\n')
      }
      case ':bank/mental-models/:id': {
        const model = await runtime.client.getMentalModel(bank!.bankId, params.id ?? '')
        return renderMentalModel({ model, pendingOperationId: null })
      }
      case ':bank/operations': {
        const list = await runtime.client.listOperations(bank!.bankId, { limit: 50 })
        return [
          `# Operations in ${bank!.id} (last ${list.operations.length} of ${list.total})`,
          '',
          ...list.operations.map(op =>
            `- ${op.created_at} · \`${op.id}\` · ${op.operation_type} · ${op.status}${op.error_message ? ` · error: ${op.error_message}` : ''}`,
          ),
        ].join('\n')
      }
      case ':bank/operations/:id': {
        const op = await runtime.client.getOperation(bank!.bankId, params.id ?? '')
        return renderOperation({ bank: bank!.id, operation: op })
      }
      case ':bank/stats': {
        const [docs, models] = await Promise.all([
          runtime.client.listDocuments(bank!.bankId, { limit: 1 }).catch(() => ({ total: 0 })),
          runtime.client.listMentalModels(bank!.bankId, { limit: 1 }).catch(() => ({ total: 0 })),
        ])
        return [
          `# Stats for ${bank!.id}`,
          '',
          `documents: ${docs.total}`,
          `mental-models: ${models.total}`,
        ].join('\n')
      }
      case 'queue':
        return renderQueue(await runtime.queue.inspect())
      case 'queue/:id': {
        const snapshot = await runtime.queue.inspect()
        const entry = [...snapshot.pending, ...snapshot.failed].find(e => e.id === params.id)
        if (!entry) throw new Error(`queue entry ${JSON.stringify(params.id)} not found`)
        return renderQueueEntry(entry)
      }
      case 'plugin/operations':
        return renderPluginOperations(runtime)
      case 'plugin/config':
        return renderPluginConfig(effective)
      default:
        throw new Error(`cannot read "${path}": unsupported route ${route.pattern}`)
    }
  }
}

/** Counts when the queue directory is readable; the failure reason instead of invented zeros when it is not. */
interface StatusQueue {
  readonly pending?: number
  readonly failed?: number
  readonly corrupt?: number
  readonly error?: string
}

/** `hindsight://plugin/status` — the panel's single probe-backed view of this project's plugin. */
async function statusDocument(runtime: HindsightRuntime, effective: ResolvedConfig) {
  const health = effective.enabled
    ? await runtime.ensureProbed()
    : { healthy: false, error: 'hindsight is disabled for this project' }
  let queue: StatusQueue
  try {
    const snapshot = await runtime.queue.inspect()
    queue = { pending: snapshot.pending.length, failed: snapshot.failed.length, corrupt: snapshot.corrupt.length }
  } catch (error) {
    queue = { error: error instanceof Error ? error.message : String(error) }
  }
  return {
    enabled: effective.enabled,
    health: {
      healthy: health.healthy,
      ...(health.version === undefined ? {} : { version: health.version }),
      ...(health.error === undefined ? {} : { error: health.error }),
    },
    // A disabled project presents no bank as available.
    banks: effective.enabled
      ? effective.banks.map(bank => ({
        id: bank.id,
        bankId: bank.bankId,
        description: bank.description ?? '',
        access: bank.access,
        retain: bank.retain.mode,
        autoTarget: bank.retain.autoTarget,
        recallEnabled: bank.recall.enabled,
      }))
      : [],
    queue,
  }
}
