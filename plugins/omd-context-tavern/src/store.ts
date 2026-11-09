/**
 * One JSON file per Bot project directory under the dsh data area.
 *
 * Every write is serialized per project and lands by temp-file + rename, so a
 * crashed process never leaves half a document. The revision is owned here,
 * never by a caller: a stale writer is rejected instead of overwriting a
 * concurrent edit.
 *
 * @module omd-context-tavern/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DOCUMENT_VERSION, defaultDocument, parseDocument, type TavernDocument } from './document.ts'

/** A write whose expected revision was not the current one. */
export class RevisionConflictError extends Error {
  /** The revision actually on disk. */
  readonly revision: number

  constructor(revision: number) {
    super(`the project document has changed; its current revision is ${revision}`)
    this.name = 'RevisionConflictError'
    this.revision = revision
  }
}

/**
 * The key of one project: its normalized absolute path.
 * @param raw - the caller-supplied path.
 * @returns the normalized absolute path.
 * @throws when the path is missing or relative.
 */
export function normalizeProject(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('a "project" absolute path is required')
  }
  const trimmed = raw.trim()
  if (!isAbsolute(trimmed)) {
    throw new Error(`"project" must be an absolute path, got ${JSON.stringify(trimmed)}`)
  }
  return resolve(trimmed)
}

/** The per-project file store. One instance per host lifetime. */
export class TavernStore {
  readonly #queues = new Map<string, Promise<void>>()

  /**
   * The file that owns one project's document. The hash is derived only from
   * the normalized absolute path, so the name can never contain a separator.
   * @param project - normalized absolute project path.
   * @returns the absolute file path.
   */
  projectFile(project: string): string {
    const digest = createHash('sha256').update(project).digest('hex')
    return dshHomePath('data', 'omd-context-tavern', 'projects', `${digest}.json`)
  }

  /**
   * Read the current document, or the default document when this project has
   * never been written.
   * @param project - normalized absolute project path.
   * @returns the current document.
   */
  async load(project: string): Promise<TavernDocument> {
    const file = this.projectFile(project)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return defaultDocument(project)
      }
      throw new Error(`cannot read tavern project file ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return parseDocument(JSON.parse(raw))
    } catch (error) {
      throw new Error(`cannot read tavern project file ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Replace the document with one built from a revision the caller read.
   * @param project - normalized absolute project path.
   * @param expectedRevision - the revision the caller based `next` on.
   * @param next - the document to store; its `revision` field is ignored.
   * @returns the committed document, with its new revision.
   * @throws RevisionConflictError when another writer has committed since.
   */
  async save(project: string, expectedRevision: number, next: TavernDocument): Promise<TavernDocument> {
    return await this.#serialize(project, async () => {
      const current = await this.load(project)
      if (current.revision !== expectedRevision) throw new RevisionConflictError(current.revision)
      return await this.#commit(project, current, next)
    })
  }

  /**
   * Apply a whole-document transformation as one serialized revision step.
   * @param project - normalized absolute project path.
   * @param change - maps the current document to the next document.
   * @returns the committed document.
   */
  async update(project: string, change: (current: TavernDocument) => TavernDocument): Promise<TavernDocument> {
    return await this.#serialize(project, async () => {
      const current = await this.load(project)
      return await this.#commit(project, current, change(current))
    })
  }

  /** @param project - normalized key. @param current - the just-read document. @param next - the new content. */
  async #commit(project: string, current: TavernDocument, next: TavernDocument): Promise<TavernDocument> {
    const committed: TavernDocument = {
      ...next,
      version: DOCUMENT_VERSION,
      revision: current.revision + 1,
      project,
    }
    const file = this.projectFile(project)
    const temp = `${file}.${randomUUID()}.tmp`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temp, `${JSON.stringify(committed, null, 2)}\n`, 'utf8')
    await rename(temp, file)
    return committed
  }

  /** Run one task after every earlier task for this project has settled. */
  #serialize<T>(project: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(project) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(() => undefined, () => undefined)
    this.#queues.set(project, tail)
    void tail.then(() => {
      if (this.#queues.get(project) === tail) this.#queues.delete(project)
    })
    return run
  }
}
