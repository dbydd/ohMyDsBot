/**
 * Host service implementation for `omd-context-notes`.
 *
 * Implements `ctx.contextNotes` with Remote endpoints for reading, saving shared
 * notes (with concurrency/stale check), updating agent notes, and managing
 * child section allocations with strict code-enforced boundaries.
 *
 * @module omd-context-notes/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import {
  parseNotebook,
  updateSharedSection,
  updateAgentSection,
  updateChildSection,
  getChildSection,
  DEFAULT_NOTEBOOK,
} from './markdown.ts'
import { appendNoteRecord } from './record.ts'
import { bindRemote, markRemoteMethods } from './remote.ts'
import type {
  ContextNotesService,
  ContextNotesState,
  NotebookGrant,
  NotebookWriteRequest,
  ReadNotesResult,
  WriteNotesResult,
} from './types.ts'

export const PROJECTION_KEY = 'contextNotes'

interface BotOwnership {
  rt: {
    selfOf(sessionId: string): string | undefined
    roomOf(sessionId: string): object | undefined
    pastOwners: Map<string, { botId?: string; roomId?: string }>
  }
}

const REMOTE_METHODS = [
  'read',
  'readSection',
  'saveShared',
  'saveAgent',
  'saveFull',
  'saveChildSection',
] as const

export class ContextNotesServiceImpl implements ContextNotesService {
  private readonly ctx: Context
  private readonly maxBytes: number
  /** Standalone sessions allocated directly (e.g. legacy/direct child notebooks). */
  private readonly allocated = new Set<string>()
  /** Active and revoked grants mapping childSessionId to parent notebook section. */
  private readonly grants = new Map<string, NotebookGrant>()
  private lastVersion = 0

  constructor(ctx: Context, maxBytes: number = 16384) {
    this.ctx = ctx
    this.maxBytes = maxBytes
    bindRemote(this, 'contextNotes', 'contextNotes')
  }

  /** Membership comes from the pinned DS-Bot runtime, including archived conversation parts. */
  isBotSession(sessionId: string): boolean {
    const bot = this.ctx.get('dsBot') as BotOwnership | undefined
    return bot !== undefined && (bot.rt.selfOf(sessionId) !== undefined
      || bot.rt.roomOf(sessionId) !== undefined || bot.rt.pastOwners.has(sessionId))
  }

  /** A delegated child can use only the notebook section its Bot parent allocated. */
  canAccess(sessionId: string): boolean {
    if (this.isBotSession(sessionId)) return true
    const grant = this.grants.get(sessionId)
    return grant?.active === true && this.isBotSession(grant.parentSessionId)
  }

  pathFor(parentSessionId: string, childSessionId?: string): string {
    if (childSessionId !== undefined && childSessionId !== '') {
      return `dsh-resource://notebook/${parentSessionId}/sections/${childSessionId}.md`
    }
    return `dsh-resource://notebook/${parentSessionId}/notes.md`
  }

  allocate(
    childSessionId: string,
    options?: { parentSessionId?: string; title?: string; initialContent?: string },
  ): { path: string; dispose: () => void } {
    const parentSessionId = options?.parentSessionId
    const title = options?.title ?? childSessionId
    this.requireBotSession(parentSessionId || childSessionId)

    if (parentSessionId !== undefined && parentSessionId !== '') {
      const grant: NotebookGrant = {
        parentSessionId,
        childSessionId,
        title,
        createdAt: Date.now(),
        active: true,
      }
      this.grants.set(childSessionId, grant)

      // Initialize the child's section in the parent notebook if not present yet
      const parentSession = this.tryResolveSession(parentSessionId)
      if (parentSession) {
        const current = this.getCurrentState(parentSession)
        const existing = getChildSection(current.text, childSessionId)
        if (existing === undefined) {
          const initial = options?.initialContent ?? ''
          const updated = updateChildSection(current.text, childSessionId, title, initial)
          this.writeState(parentSession, updated, 'agent', 'agent')
        }
      }

      return {
        path: this.pathFor(parentSessionId, childSessionId),
        dispose: () => {
          // Disposal revokes writing permissions while retaining content visible to parent
          const g = this.grants.get(childSessionId)
          if (g) {
            g.active = false
          }
        },
      }
    }

    // Standalone session allocation
    this.allocated.add(childSessionId)
    if (options?.initialContent !== undefined) {
      const session = this.tryResolveSession(childSessionId)
      if (session) {
        this.writeState(session, options.initialContent, 'agent', 'full')
      }
    }

    return {
      path: this.pathFor(childSessionId),
      dispose: () => {
        this.allocated.delete(childSessionId)
      },
    }
  }

  private tryResolveSession(sessionIdStr: string): Session | undefined {
    try {
      return this.ctx.sessions?.get(SessionId(sessionIdStr))
    } catch {
      return undefined
    }
  }

  private requireBotSession(sessionId: string): void {
    if (!this.isBotSession(sessionId)) {
      throw new Error('contextNotes: notebooks are available only for DS-Bot conversations')
    }
  }

  private resolveSession(sessionIdStr: string): Session {
    const session = this.tryResolveSession(sessionIdStr)
    if (!session) {
      throw new Error(`contextNotes: session "${sessionIdStr}" not found`)
    }
    this.requireBotSession(sessionIdStr)
    return session
  }

  private getCurrentState(session: Session): ContextNotesState {
    const raw = this.ctx.sessionProjections?.stateOf(session, PROJECTION_KEY)
    if (raw && typeof raw.text === 'string' && typeof raw.version === 'number' && raw.text !== '') {
      return raw
    }
    return {
      text: DEFAULT_NOTEBOOK,
      bytes: Buffer.byteLength(DEFAULT_NOTEBOOK, 'utf8'),
      version: 0,
    }
  }

  /** Append one notebook revision event and return the new state. */
  private writeState(
    session: Session,
    text: string,
    author: 'user' | 'agent',
    section: 'shared' | 'agent' | 'full',
  ): ReadNotesResult {
    const bytes = Buffer.byteLength(text, 'utf8')
    let version = Date.now()
    if (version <= this.lastVersion) {
      version = this.lastVersion + 1
    }
    this.lastVersion = version
    appendNoteRecord(session, {
      text,
      bytes,
      version,
      author,
      section,
    })
    const parsed = parseNotebook(text)
    return {
      fullText: text,
      sharedText: parsed.sharedSection,
      agentText: parsed.agentSection,
      version,
      bytes,
    }
  }

  private reject(message: string, state?: ReadNotesResult): WriteNotesResult {
    return { ok: false, error: message, ...(state !== undefined ? { state } : {}) }
  }

  async read(sessionId: string): Promise<ReadNotesResult> {
    const session = this.resolveSession(sessionId)
    const current = this.getCurrentState(session)
    const parsed = parseNotebook(current.text)
    return {
      fullText: current.text,
      sharedText: parsed.sharedSection,
      agentText: parsed.agentSection,
      version: current.version,
      bytes: current.bytes,
    }
  }

  async readSection(sessionId: string, childSessionId: string): Promise<string> {
    const session = this.resolveSession(sessionId)
    const current = this.getCurrentState(session)
    return getChildSection(current.text, childSessionId) ?? ''
  }

  /**
   * Unified write choke point for all notebook writes (Host API and internalPaths).
   *
   * Enforces:
   * 1. Concurrency check via expectedVersion (protecting user shared notes).
   * 2. Model full replace protection (cannot overwrite concurrent user edits without matching version).
   * 3. Scoped permissions: child can ONLY write to its granted subsection; cannot write shared, parent scratchpad, or sibling sections.
   * 4. Revocation upon disposal: write rejected once grant is disposed, while content remains retained.
   */
  async write(request: NotebookWriteRequest): Promise<WriteNotesResult> {
    const session = this.resolveSession(request.sessionId)
    const current = this.getCurrentState(session)
    const caller = request.callerSessionId
    const isHuman = request.origin === 'human' || request.author === 'user'

    // 1. Authorize target
    if (typeof request.target === 'object' && 'section' in request.target) {
      const childId = request.target.section
      if (!isHuman && caller !== request.sessionId) {
        if (caller !== childId) {
          return this.reject(
            `Permission denied: caller session "${caller ?? 'unknown'}" is not authorized to write child section "${childId}"`,
          )
        }
        const grant = this.grants.get(childId)
        if (!grant || grant.parentSessionId !== request.sessionId) {
          return this.reject(
            `Permission denied: no active section allocation for child "${childId}" on parent session "${request.sessionId}"`,
          )
        }
        if (!grant.active) {
          return this.reject(
            `Permission denied: section allocation for child "${childId}" has been revoked or disposed`,
          )
        }
      }

      const grant = this.grants.get(childId)
      const title = grant?.title ?? childId
      const nextFullText = updateChildSection(current.text, childId, title, request.content)
      const bytes = Buffer.byteLength(nextFullText, 'utf8')
      if (bytes > this.maxBytes) {
        return this.reject(`Note exceeds maximum size of ${this.maxBytes} bytes (attempted ${bytes} bytes)`)
      }
      const state = this.writeState(session, nextFullText, request.author, 'agent')
      return { ok: true, state }
    }

    // Targets 'shared', 'agent', or 'full'
    if (!isHuman && caller !== undefined && caller !== request.sessionId) {
      return this.reject(
        `Permission denied: child subagent "${caller}" cannot write parent notebook directly; write only to your assigned section`,
      )
    }

    if (request.target === 'shared') {
      if (
        request.expectedVersion !== undefined
        && current.version !== request.expectedVersion
      ) {
        const parsed = parseNotebook(current.text)
        return this.reject(
          `Conflict: notes were modified concurrently (current version: ${current.version}, expected: ${request.expectedVersion})`,
          {
            fullText: current.text,
            sharedText: parsed.sharedSection,
            agentText: parsed.agentSection,
            version: current.version,
            bytes: current.bytes,
          },
        )
      }

      const nextFullText = updateSharedSection(current.text, request.content)
      const bytes = Buffer.byteLength(nextFullText, 'utf8')
      if (bytes > this.maxBytes) {
        return this.reject(`Note exceeds maximum size of ${this.maxBytes} bytes (attempted ${bytes} bytes)`)
      }
      const state = this.writeState(session, nextFullText, request.author, 'shared')
      return { ok: true, state }
    }

    if (request.target === 'agent') {
      const nextFullText = updateAgentSection(current.text, request.content)
      const bytes = Buffer.byteLength(nextFullText, 'utf8')
      if (bytes > this.maxBytes) {
        return this.reject(`Note exceeds maximum size of ${this.maxBytes} bytes (attempted ${bytes} bytes)`)
      }
      const state = this.writeState(session, nextFullText, request.author, 'agent')
      return { ok: true, state }
    }

    // target === 'full'
    if (
      request.expectedVersion !== undefined
      && current.version !== request.expectedVersion
    ) {
      const parsed = parseNotebook(current.text)
      return this.reject(
        `Conflict: notes were modified concurrently (current version: ${current.version}, expected: ${request.expectedVersion})`,
        {
          fullText: current.text,
          sharedText: parsed.sharedSection,
          agentText: parsed.agentSection,
          version: current.version,
          bytes: current.bytes,
        },
      )
    }

    // Model full replace check: protect concurrent user edits in the shared section
    if (request.author === 'agent' && current.version !== 0) {
      const incomingParsed = parseNotebook(request.content)
      const currentParsed = parseNotebook(current.text)
      if (incomingParsed.sharedSection.trim() !== currentParsed.sharedSection.trim()) {
        if (request.expectedVersion === undefined || request.expectedVersion !== current.version) {
          return this.reject(
            `Conflict: model full replace cannot overwrite concurrent user edits in the shared section without matching expectedVersion (current: ${current.version})`,
            {
              fullText: current.text,
              sharedText: currentParsed.sharedSection,
              agentText: currentParsed.agentSection,
              version: current.version,
              bytes: current.bytes,
            },
          )
        }
      }
    }

    const bytes = Buffer.byteLength(request.content, 'utf8')
    if (bytes > this.maxBytes) {
      return this.reject(`Note exceeds maximum size of ${this.maxBytes} bytes (attempted ${bytes} bytes)`)
    }
    const state = this.writeState(session, request.content, request.author, 'full')
    return { ok: true, state }
  }

  async saveShared(sessionId: string, sharedText: string, expectedVersion: number): Promise<WriteNotesResult> {
    return this.write({
      sessionId,
      target: 'shared',
      content: sharedText,
      expectedVersion,
      author: 'user',
      origin: 'human',
    })
  }

  async saveAgent(sessionId: string, agentText: string): Promise<WriteNotesResult> {
    return this.write({
      sessionId,
      target: 'agent',
      content: agentText,
      author: 'agent',
      origin: 'model',
      callerSessionId: sessionId,
    })
  }

  async saveFull(sessionId: string, fullText: string, expectedVersion?: number): Promise<WriteNotesResult> {
    return this.write({
      sessionId,
      target: 'full',
      content: fullText,
      expectedVersion,
      author: 'agent',
      origin: 'model',
      callerSessionId: sessionId,
    })
  }

  async saveChildSection(
    parentSessionId: string,
    childSessionId: string,
    content: string,
    callerSessionId?: string,
  ): Promise<WriteNotesResult> {
    return this.write({
      sessionId: parentSessionId,
      target: { section: childSessionId },
      content,
      author: 'agent',
      origin: 'model',
      callerSessionId: callerSessionId ?? childSessionId,
    })
  }
}

markRemoteMethods(ContextNotesServiceImpl.prototype, REMOTE_METHODS)
