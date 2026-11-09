/**
 * The model-facing memory tools: `memory_recall`, `memory_retain`,
 * `memory_reflect` — the same three verbs the omp deployment exposes.
 *
 * @module omd-hindsight/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Banks, RecallHit } from './banks.ts'
import type { ResolvedConfig } from './config.ts'

/** The session's working directory, which picks the project bank. */
function cwdOf(session: Session): string {
  return session.header?.cwd ?? process.cwd()
}

/** One hit as the tool returns it. */
const hitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'The memory id, for curation.' },
    text: { type: 'string', required: true, description: 'The memory text.' },
    bank: { type: 'string', required: true, description: 'Which bank the memory came from.' },
    type: { type: 'string', required: true, description: 'The memory type, when the server gives one.' },
  },
} as const

/** Render recalled hits as the model reads them. */
function renderHits(hits: readonly RecallHit[]): { type: 'text'; text: string }[] {
  if (hits.length === 0) return [{ type: 'text', text: 'No memories matched.' }]
  const lines = hits.map(hit => `- [${hit.bank}${hit.type === undefined ? '' : `/${hit.type}`}] ${hit.text.trim()}  (id: ${hit.id})`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Register the three memory tools on one tool registry.
 * @param tools - the registry to register into (the plugin's `ctx.tools`).
 * @param banks - the bank operations.
 * @param config - resolved plugin configuration.
 */
export function registerMemoryTools(
  tools: Pick<Context['tools'], 'register'>,
  banks: Banks,
  config: ResolvedConfig,
): void {
  tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Search durable memory from earlier sessions (this project\'s bank plus the shared bank). '
      + 'Call it when the user refers to past decisions, conventions, or work you have no record of '
      + 'in this conversation.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look for, as a phrase or question.' },
      scope: {
        type: 'string',
        enum: ['both', 'project', 'global'],
        description: 'Which banks to search. Defaults to both.',
      },
      maxTokens: { type: 'string', description: 'Token budget for the lookup. Omit for the default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { hits: { type: 'array', items: hitSchema }, text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('memory_recall requires an owning agent session')
      const cwd = cwdOf(exec.agent.session)
      const raw = args.maxTokens
      const budget = raw === undefined || raw.length === 0 ? config.maxRecallTokens : Number.parseInt(raw, 10)
      if (!Number.isFinite(budget) || budget <= 0) throw new Error('memory_recall: `maxTokens` must be a positive integer')
      const signal = exec.signal ?? new AbortController().signal
      const scope = args.scope ?? 'both'
      const hits = scope === 'both'
        ? await banks.recall(cwd, args.query, signal)
        : await banks.recallScoped(cwd, args.query, scope, budget, signal)
      const rendered = renderHits(hits)[0]?.text ?? ''
      return {
        hits: hits.map(hit => ({
          id: hit.id,
          text: hit.text,
          bank: hit.bank ?? 'memory',
          ...(hit.type === undefined ? {} : { type: hit.type }),
        })),
        text: rendered,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Recall memory', kind: 'read', rawInput: args }),
  }))

  tools.register(defineTool({
    name: 'memory_retain',
    description:
      'Store one durable memory for later sessions. Write facts about the project, decisions and their '
      + 'reasons, conventions, and the user\'s standing preferences — not conversational detail.',
    parameters: {
      content: { type: 'string', required: true, description: 'The memory, as one self-contained statement.' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: '`project` (default) keeps it with this project; `global` makes it visible everywhere.',
      },
      timestamp: {
        type: 'string',
        description: 'When the fact was true, as ISO-8601 (or "unset" for timeless content). Omit for now.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { scope: { type: 'string' }, queued: { type: 'boolean' } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.queued
          ? `Stored in the ${value.scope} memory (extraction runs in the background).`
          : `Stored in the ${value.scope} memory.`,
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('memory_retain requires an owning agent session')
      const content = args.content.trim()
      if (content.length === 0) throw new Error('memory_retain: `content` must be a non-empty statement')
      const scope = args.scope ?? 'project'
      const signal = exec.signal ?? new AbortController().signal
      await banks.retain(cwdOf(exec.agent.session), content, scope, args.timestamp, signal)
      return { scope, queued: config.retainAsync }
    },
    presentCall: args => ({ card: 'generic', title: 'Retain memory', kind: 'other', rawInput: args }),
  }))

  tools.register(defineTool({
    name: 'memory_reflect',
    description:
      'Ask memory for a synthesized answer rather than a list of facts — use it for "what is the state of '
      + 'X" or "what did we decide about Y" questions that span many stored memories.',
    parameters: {
      query: { type: 'string', required: true, description: 'The question to answer from memory.' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'Which bank to reflect on. Defaults to project.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { scope: { type: 'string' }, text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('memory_reflect requires an owning agent session')
      const scope = args.scope ?? 'project'
      const signal = exec.signal ?? new AbortController().signal
      const text = await banks.reflect(cwdOf(exec.agent.session), args.query, scope, signal)
      return { scope, text }
    },
    presentCall: args => ({ card: 'generic', title: 'Reflect on memory', kind: 'read', rawInput: args }),
  }))
}
