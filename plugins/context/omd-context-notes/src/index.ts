/**
 * `omd-context-notes` — an explicit working-memory notebook for one session.
 *
 * Implements:
 * - Two-part notebook markdown structure (# Shared and # Agent notes).
 * - Projection-backed persistence (`contextNotes` projection) replaying
 *   `plugin:omd-context-notes/updated` records.
 * - Prompt section rendering the latest notebook revision into the model's view.
 * - Section-scoped updates (`section: "shared" | "agent" | "full"` or `{ section: childId }`)
 *   and version concurrency check.
 * - `ctx.contextNotes` Host service with Typert Remote endpoints for browser client.
 * - `dsh-resource://notebook/<sessionId>/{notes.md,shared.md,agent.md,sections/<childId>.md}`
 *   internal path source with strict code-enforced boundaries.
 * - Universal write choke point preserving human shared notes from model race conditions.
 *
 * @module omd-context-notes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { z as zod, type ZodType } from 'zod'
import {
  parseNotebook,
  DEFAULT_NOTEBOOK,
} from './markdown.ts'
import {
  ContextNotesServiceImpl,
  PROJECTION_KEY,
} from './service.ts'
import { NOTE_RECORD_TYPE } from './record.ts'
import type { ContextNotesState } from './types.ts'
import type { InternalExec, InternalPathsService, InternalSource } from '../../../host/omd-internal-paths/src/index.ts'

export type * from './types.ts'
export {
  parseNotebook,
  updateSharedSection,
  updateAgentSection,
  updateChildSection,
  getChildSection,
  DEFAULT_NOTEBOOK,
} from './markdown.ts'
export { ContextNotesServiceImpl, PROJECTION_KEY } from './service.ts'

/** The system-prompt section that renders the notebook into the model's view. */
const SECTION = 'omd:context-notes'

/** Plugin id the Loader entry carries. */
export const name = 'omd-context-notes'

/** Services this plugin needs before its fiber activates. */
export const inject = ['systemPrompt', 'sessionProjections', 'sessions', 'dsBot']

/** Deployment settings for the notebook. */
export interface Config {
  /** Largest UTF-8 byte length a write may commit; larger writes fail instead of truncating. */
  maxBytes: number
  /** Position of the notebook section in the assembled system prompt; lower renders earlier. */
  sectionOrder: number
}

/** Schemastery configuration for the notebook. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().step(1).min(1).default(16384)
    .description('Maximum UTF-8 bytes allowed in the notebook; larger writes are rejected.'),
  sectionOrder: z.natural().default(85)
    .description('Position of the notebook section in the assembled system prompt; lower renders earlier.'),
})

/** The revision a session that never wrote a notebook reads; nobody mutates it. */
const EMPTY: ContextNotesState = {
  text: DEFAULT_NOTEBOOK,
  bytes: Buffer.byteLength(DEFAULT_NOTEBOOK, 'utf8'),
  version: 0,
}

/** Host fold schema; what the projection cache persists. */
const stateSchema: ZodType<ContextNotesState> = zod.object({
  text: zod.string(),
  bytes: zod.number().int().nonnegative(),
  version: zod.number().int().nonnegative(),
})

/** Schema for tool/result presentationMeta fallback. */
const toolResultMetaSchema = zod.object({
  contextNotes: zod.object({
    text: zod.string(),
    bytes: zod.number().int().nonnegative(),
    version: zod.number().int().nonnegative(),
  }),
})

/**
 * State the write ceiling in whole KiB or bytes.
 */
function describeBound(maxBytes: number): string {
  return maxBytes % 1024 === 0
    ? `${String(maxBytes / 1024)} KiB (${String(maxBytes)}-byte)`
    : `${String(maxBytes)}-byte`
}

/**
 * The disciplines the section states, shared by every session.
 */
function disciplineText(maxBytes: number): string {
  return [
    'This working-memory notebook is persistent context for this session. It has two parts:',
    '1. `# Shared` (the first level-one heading and its section): shared and collaboratively editable with the human user.',
    '2. `# Agent notes` (the second level-one heading onwards): your private working memory and scratchpad. The user sees it read-only.',
    'Read or update the notebook using internal paths `notebook://<sessionId>/{notes.md,shared.md,agent.md}` or allocated child sections `notebook://<parentSessionId>/sections/<childId>.md`.',
    `Keep the notebook structured, concise, and under ${describeBound(maxBytes)}. Replace stale items instead of endlessly appending.`,
  ].join('\n')
}

interface NotebookTarget {
  sessionId: string
  type: 'full' | 'shared' | 'agent' | 'section'
  childId?: string
}

/**
 * Resolve a notebook path to its target session and file/section.
 *
 * @param rawPath - the source path, `<sessionId>/{notes.md,shared.md,agent.md}` or `<sessionId>/sections/<childId>.md`.
 * @param exec - the calling execution, for the `current` alias.
 * @returns the resolved target descriptor.
 * @throws when the path is malformed.
 */
function notebookTarget(
  rawPath: string,
  exec?: InternalExec,
): NotebookTarget {
  const parts = rawPath.trim().replace(/^\/+/u, '').split('/')
  const rawSessionId = parts[0]
  const sessionId = rawSessionId === 'current'
    ? exec?.agent?.session?.id === undefined ? undefined : String(exec.agent.session.id)
    : rawSessionId
  if (sessionId === undefined || sessionId === '') {
    throw new Error(`cannot resolve "notebook://${rawPath}": missing or invalid sessionId`)
  }

  if (parts[1] === 'sections' && parts[2]) {
    const childId = parts[2].replace(/\.md$/u, '')
    if (childId === '') {
      throw new Error(`invalid section path "notebook://${rawPath}": missing childId`)
    }
    return { sessionId, type: 'section', childId }
  }

  const file = parts[1] ?? 'notes.md'
  if (file === 'notes.md') return { sessionId, type: 'full' }
  if (file === 'shared.md') return { sessionId, type: 'shared' }
  if (file === 'agent.md') return { sessionId, type: 'agent' }

  throw new Error(`notebook has no file "${file}"; use notes.md, shared.md, agent.md, or sections/<childId>.md`)
}

/** Schema validating incoming sidebar API request bodies. */
const routeBodySchema = zod.discriminatedUnion('op', [
  zod.object({
    op: zod.literal('read'),
    sessionId: zod.string().min(1),
    childId: zod.string().optional(),
  }),
  zod.object({
    op: zod.literal('save'),
    sessionId: zod.string().min(1),
    text: zod.string(),
    section: zod.enum(['shared', 'agent', 'full']),
    expectedVersion: zod.number().int().optional(),
  }),
  zod.object({
    op: zod.literal('saveSection'),
    sessionId: zod.string().min(1),
    childId: zod.string().min(1),
    text: zod.string(),
  }),
])

/**
 * Register the `contextNotes` projection, system prompt section, host service,
 * and internal path source.
 */
export function apply(ctx: Context, config: Config): void {
  const discipline = disciplineText(config.maxBytes)
  const service = new ContextNotesServiceImpl(ctx, config.maxBytes)
  ctx.provide('contextNotes', service)

  // HTTP API route for browser client panel
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as
      | { fetch?: { register?: (route: unknown) => () => void } }
      | undefined
    if (connection?.fetch?.register === undefined) return
    scope.effect(() => connection.fetch!.register!({
      path: '/api/plugins/omd-context-notes/notes',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405 })
        let rawJson: unknown
        try {
          rawJson = await request.json()
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 })
        }

        const parseResult = routeBodySchema.safeParse(rawJson)
        if (!parseResult.success) {
          return Response.json({ error: 'Invalid request body schema', details: parseResult.error.format() }, { status: 400 })
        }
        const data = parseResult.data

        try {
          if (data.op === 'read') {
            if (data.childId) {
              const text = await service.readSection(data.sessionId, data.childId)
              return Response.json({ text })
            }
            return Response.json(await service.read(data.sessionId))
          }
          if (data.op === 'save') {
            if (data.section === 'shared') {
              return Response.json(await service.saveShared(data.sessionId, data.text, data.expectedVersion ?? 0))
            }
            if (data.section === 'agent') {
              return Response.json(await service.saveAgent(data.sessionId, data.text))
            }
            return Response.json(await service.saveFull(data.sessionId, data.text, data.expectedVersion))
          }
          if (data.op === 'saveSection') {
            return Response.json(await service.saveChildSection(data.sessionId, data.childId, data.text))
          }
          return Response.json({ error: 'unsupported operation' }, { status: 400 })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    }), 'omd-context-notes: sidebar route')
  })

  // 1. Session Projection
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 2,
    stateSchema,
    init: () => ({ ...EMPTY }),
    apply(state, event: SessionEvent) {
      if (event.type === NOTE_RECORD_TYPE) {
        const data: unknown = event.data
        if (data !== null && typeof data === 'object'
          && 'text' in data && typeof data.text === 'string'
          && 'bytes' in data && typeof data.bytes === 'number'
          && 'version' in data && typeof data.version === 'number') {
          return { text: data.text, bytes: data.bytes, version: data.version }
        }
      }
      if (event.type === 'tool/result') {
        const eventData: unknown = event.data
        if (eventData && typeof eventData === 'object' && 'meta' in eventData) {
          const parsedMeta = toolResultMetaSchema.safeParse(eventData.meta)
          if (parsedMeta.success) {
            const snapshot = parsedMeta.data.contextNotes
            return { text: snapshot.text, bytes: snapshot.bytes, version: snapshot.version }
          }
        }
      }
      return state
    },
  })

  // 2. System Prompt Section
  ctx.systemPrompt.section({
    name: SECTION,
    order: config.sectionOrder,
    interpolate: false,
    text: (context: AssembleContext) => {
      const session = context.agent?.session
      if (!session || !service.isBotSession(String(session.id))) return ''
      const notes = ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? EMPTY
      if (notes.text.trim() === '') return ''
      return [
        '<experimental-context-notes>',
        discipline,
        '',
        `Latest notebook revision ${notes.version} (${String(notes.bytes)} bytes):`,
        notes.text,
        '</experimental-context-notes>',
      ].join('\n')
    },
  })

  // 3. Internal paths source: dsh-resource://notebook/<sessionId>/...
  ctx.inject(['internalPaths'], (scope) => {
    const internalPaths = scope.get('internalPaths') as InternalPathsService | undefined
    if (!internalPaths) return
    const source: InternalSource = {
      grammar:
        'notebook://<sessionId>/{notes.md,shared.md,agent.md,scope.json} or '
        + 'notebook://<parentSessionId>/sections/<childId>.md',
      description:
        'DS-Bot conversation working memory; scope.json is read-only membership metadata. Read notes.md for the whole notebook; write shared.md or agent.md to '
        + 'replace one section while the other is preserved. Child subagents write exclusively to '
        + 'their allocated section at sections/<childId>.md.',
      shorthand: true,
      live: true,
      available(exec: InternalExec) {
        const caller = exec.agent?.session.id ?? exec.sessionId
        return caller === undefined || service.canAccess(String(caller))
      },
      async read(path: string, exec: InternalExec) {
        if (/^[^/]+\/scope\.json$/u.test(path)) {
          return JSON.stringify({ bot: service.isBotSession(path.split('/')[0]!) })
        }
        const target = notebookTarget(path, exec)
        if (!service.isBotSession(target.sessionId)) {
          throw new Error('contextNotes: notebooks are available only for DS-Bot conversations')
        }
        const session = ctx.sessions?.get(SessionId(target.sessionId))
        if (!session) {
          throw new Error(`cannot read "notebook://${path}": session "${target.sessionId}" not found`)
        }
        if (target.type === 'section') {
          return await service.readSection(target.sessionId, target.childId!)
        }
        const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? EMPTY
        const text = state.text === '' ? DEFAULT_NOTEBOOK : state.text
        if (target.type === 'shared') return parseNotebook(text).sharedSection
        if (target.type === 'agent') return parseNotebook(text).agentSection
        return text
      },
      async write(path: string, content: string, exec: InternalExec): Promise<string> {
        const target = notebookTarget(path, exec)
        const callerSessionId = exec.agent ? String(exec.agent.session.id) : exec.sessionId
        const origin = exec.origin ?? (exec.agent ? 'model' : 'human')
        const author = origin === 'human' ? 'user' : 'agent'

        const writeTarget = target.type === 'section'
          ? { section: target.childId! }
          : target.type

        const result = await service.write({
          sessionId: target.sessionId,
          target: writeTarget,
          content,
          author,
          origin,
          callerSessionId,
        })

        if (!result.ok) {
          throw new Error(result.error ?? 'the notebook write was rejected')
        }
        return `Successfully updated notebook for session "${target.sessionId}".`
      },
    }
    scope.effect(() => internalPaths.register('notebook', source), 'omd-context-notes: notebook path source')
  })
}
