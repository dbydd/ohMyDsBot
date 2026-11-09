/**
 * Types and declaration merges for `omd-context-notes`.
 *
 * @module omd-context-notes/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** The notebook's whole current revision, never a delta. */
export interface ContextNotesState {
  /** The notebook body exactly as written. */
  text: string
  /** UTF-8 byte length of {@link text}. */
  bytes: number
  /** Writer wall-clock stamp; revision marker for concurrency. */
  version: number
}

/** Result of reading a notebook. */
export interface ReadNotesResult {
  fullText: string
  sharedText: string
  agentText: string
  version: number
  bytes: number
}

/** Result of writing to a notebook. */
export interface WriteNotesResult {
  ok: boolean
  error?: string
  state?: ReadNotesResult
}

/** One active or revoked notebook section delegation grant. */
export interface NotebookGrant {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly title: string
  readonly createdAt: number
  active: boolean
}

/** Request to write to a notebook or section through the unified choke point. */
export interface NotebookWriteRequest {
  readonly sessionId: string
  readonly target: 'full' | 'shared' | 'agent' | { section: string }
  readonly content: string
  readonly expectedVersion?: number
  readonly author: 'user' | 'agent'
  readonly origin?: 'human' | 'model' | string
  readonly callerSessionId?: string
}

/** Service interface exposed on `ctx.contextNotes`. */
export interface ContextNotesService {
  /** Whether the session belongs to a Bot or group, including archived parts. */
  isBotSession(sessionId: string): boolean
  /** Whether the session is a Bot conversation or has an active delegated notebook section. */
  canAccess(sessionId: string): boolean
  /** Return the canonical internal path for a session's notebook or child section. */
  pathFor(parentSessionId: string, childSessionId?: string): string
  /** Read the full notebook and its parsed sections for a session. */
  read(sessionId: string): Promise<ReadNotesResult>
  /** Read only one child section from the parent notebook. */
  readSection(sessionId: string, childSessionId: string): Promise<string>
  /** Unified write choke point with origin, identity, and concurrency checks. */
  write(request: NotebookWriteRequest): Promise<WriteNotesResult>
  /** Update the shared section (with concurrency check). */
  saveShared(sessionId: string, sharedText: string, expectedVersion: number): Promise<WriteNotesResult>
  /** Update the agent section. */
  saveAgent(sessionId: string, agentText: string): Promise<WriteNotesResult>
  /** Update the full notebook text. */
  saveFull(sessionId: string, fullText: string, expectedVersion?: number): Promise<WriteNotesResult>
  /** Update one child section under the parent notebook's agent area. */
  saveChildSection(
    parentSessionId: string,
    childSessionId: string,
    content: string,
    callerSessionId?: string,
  ): Promise<WriteNotesResult>
  /**
   * Allocate or initialize a notebook for a child or new session.
   * @param childSessionId - target session id
   * @param options - optional initial content or parent inheritance
   */
  allocate(
    childSessionId: string,
    options?: { parentSessionId?: string; title?: string; initialContent?: string },
  ): { path: string; dispose: () => void }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The session branch's current notebook revision. */
    contextNotes: ContextNotesState
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Plugin record: ignorable by contract, so an older reader skips it instead of refusing the log. */
    'plugin:omd-context-notes/updated': {
      text: string
      bytes: number
      version: number
      author: 'user' | 'agent'
      section: 'shared' | 'agent' | 'full'
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Context notes working-memory service. */
    contextNotes: ContextNotesService
  }
}
