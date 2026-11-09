/**
 * `omd-context-tavern` — host half.
 *
 * The browser half draws the context strip and the Tavern Studio (project-level
 * Bot config, lorebook, Author's Note, epoch archive, story notes). This half
 * owns the state: one versioned JSON file per Bot project directory, served
 * over the `project` route and exposed to the model as `tavern://` internal
 * paths. A project is the absolute working directory of a Bot's session, so
 * the same state is shared across sessions and browsers.
 *
 * The `roots` route still reports the deployment's fallback workspace root;
 * global settings pages resolve relative markdown image paths against it.
 *
 * @module omd-context-tavern
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { InternalPathsService } from '../../omd-internal-paths/src/index.ts'
import { DOCUMENT_VERSION, parseDocument, type TavernDocument } from './document.ts'
import { tavernSource } from './source.ts'
import { normalizeProject, RevisionConflictError, TavernStore } from './store.ts'

/** Plugin name for registration in Cordis. */
export const name = 'omd-context-tavern'

/** Route the Client half reads the fallback root from. */
const ROOTS_ROUTE = '/api/plugins/omd-context-tavern/roots'

/** Route the Client half reads and writes the project document through. */
const PROJECT_ROUTE = '/api/plugins/omd-context-tavern/project'

/** The part of `ctx.sandboxPolicy` the roots route reads. */
interface SandboxPolicyFace {
  workspaceRoot?: string
}

/** The part of `ctx.connection.fetch` this plugin registers routes on. */
interface ConnectionFetchFace {
  register(route: {
    path: string
    methods: string[]
    requestBody: string
    fetch: (request: Request) => Promise<Response>
  }): () => void
}

/** Body of a document write: the caller's revision is the concurrency guard. */
const postBodySchema = z.object({
  project: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  document: z.unknown(),
})

/**
 * Read the deployment workspace root: the absolute fallback root a Session
 * without its own cwd works in, which dsh also uses for agentless calls.
 * @param ctx - Host context.
 * @returns the absolute root, or undefined when no policy service is composed.
 */
function deploymentRoot(ctx: Context): string | undefined {
  const policy = ctx.get('sandboxPolicy') as SandboxPolicyFace | undefined
  const root = policy?.workspaceRoot
  return typeof root === 'string' && root !== '' ? root : undefined
}

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

/** The document fields a browser write may replace; the store owns the rest. */
function bodyDocument(raw: unknown, project: string, revision: number): TavernDocument {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"document" must be an object')
  }
  return parseDocument({ ...raw, version: DOCUMENT_VERSION, project, revision })
}

/**
 * Serve one project document request.
 * @param request - the HTTP request, carrying the project in the query (GET)
 *   or in the body (POST).
 * @param store - the per-project file store.
 * @returns the document, the write receipt, or a 400/409/500 failure.
 */
async function projectRequest(request: Request, store: TavernStore): Promise<Response> {
  if (request.method === 'GET') {
    const raw = new URL(request.url).searchParams.get('project')
    let project: string
    try {
      project = normalizeProject(raw)
    } catch (error) {
      return failure(400, error instanceof Error ? error.message : String(error))
    }
    try {
      return Response.json(await store.load(project), { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return failure(500, error instanceof Error ? error.message : String(error))
    }
  }
  if (request.method !== 'POST') return failure(405, 'GET or POST required')

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return failure(400, 'invalid JSON body')
  }
  const body = postBodySchema.safeParse(raw)
  if (!body.success) {
    return failure(400, `invalid request body: ${body.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`)
  }
  let project: string
  let document: TavernDocument
  try {
    project = normalizeProject(body.data.project)
    // Shape validation runs before the revision check, so a stale write carrying a
    // malformed document answers 400 instead of 409. The Studio always sends a whole
    // document, which is why only hand-written requests can reach that order; keeping
    // it this way because a clear "which field is wrong" beats a bare conflict.
    document = bodyDocument(body.data.document, project, body.data.expectedRevision)
  } catch (error) {
    return failure(400, error instanceof Error ? error.message : String(error))
  }
  try {
    const committed = await store.save(project, body.data.expectedRevision, document)
    return Response.json({ ok: true, revision: committed.revision })
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return Response.json({ error: error.message, revision: error.revision }, { status: 409 })
    }
    return failure(500, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Register the roots and project routes and the `tavern://` internal path
 * source. Every registration is tied to the plugin fiber by `ctx.effect`.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  const store = new TavernStore()
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as { fetch?: ConnectionFetchFace } | undefined
    if (connection?.fetch === undefined) return
    scope.effect(() => connection.fetch!.register({
      path: ROOTS_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (): Promise<Response> =>
        Response.json({ workspaceRoot: deploymentRoot(scope) ?? null }),
    }), 'omd-context-tavern: roots route')
    scope.effect(() => connection.fetch!.register({
      path: PROJECT_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request: Request): Promise<Response> => projectRequest(request, store),
    }), 'omd-context-tavern: project route')
  })

  ctx.inject(['internalPaths'], (scope) => {
    const internalPaths = scope.get('internalPaths') as InternalPathsService | undefined
    if (internalPaths === undefined) return
    scope.effect(() => internalPaths.register('tavern', tavernSource(store)),
      'omd-context-tavern: tavern path source')
  })
}
