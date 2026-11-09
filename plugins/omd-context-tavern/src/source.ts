/**
 * `tavern://` — the model's view of a Bot's project-level context config.
 * All addresses resolve against the calling session's working directory, so
 * two sessions working in the same project see the same lorebook, Author's
 * Note, story notes and epoch archive.
 *
 * @module omd-context-tavern/source
 */

import type { InternalExec, InternalSource } from '../../omd-internal-paths/src/index.ts'
import type { TavernDocument } from './document.ts'
import { normalizeProject, type TavernStore } from './store.ts'

/** Address forms this source serves. */
export const TAVERN_GRAMMAR = 'tavern://{lorebook/<entryId>.md,author-note.md,story.md,epochs.json}'

const LORE_FILE = /^lorebook\/([^/]+)\.md$/u

function unknownPath(path: string): Error {
  return new Error(
    `tavern has no file ${JSON.stringify(path)}; use ${TAVERN_GRAMMAR} (epochs.json is read-only)`,
  )
}

/** The project one execution is bound to; a cwd-less call has no project. */
function projectOf(exec: InternalExec): string {
  const cwd = exec.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error(
      'tavern:// is project-scoped and needs a session with a working directory (需要项目会话); '
      + 'call it from a Bot or conversation session, not a context-free remote call',
    )
  }
  return normalizeProject(cwd)
}

/** Entry id from a `lorebook/<id>.md` address, or undefined for other files. */
function loreId(path: string): string | undefined {
  return LORE_FILE.exec(path)?.[1]
}

/**
 * Build the source the registry owns. Every write goes through one serialized
 * store update, so an agent editing the note and a human saving the panel in
 * the same project cannot lose each other's revision.
 *
 * @param store - the project file store.
 * @returns the source to register as `tavern`.
 */
export function tavernSource(store: TavernStore): InternalSource {
  return {
    grammar: TAVERN_GRAMMAR,
    description:
      'The project-level context configuration of one Bot: the lorebook catalog, Author\'s Note, story notes and archived epochs, shared by every session and browser working in the calling session\'s directory. '
      + '这是 Bot 的项目级上下文配置。Read author-note.md, story.md, lorebook/<entryId>.md or epochs.json; '
      + 'write replaces the whole file content. epochs.json is read-only. Reading the root address lists the entries.',
    shorthand: true,
    live: true,
    async read(path: string, exec: InternalExec): Promise<string> {
      const project = projectOf(exec)
      const document = await store.load(project)
      const file = path.trim().replace(/^\/+/u, '')
      if (file === '') {
        return JSON.stringify({
          project: document.project,
          revision: document.revision,
          epochId: document.epochId,
          files: ['author-note.md', 'story.md', 'epochs.json'],
          lorebook: document.lorebook.map(entry => ({
            path: `lorebook/${entry.id}.md`,
            id: entry.id,
            name: entry.name,
            keys: entry.keys,
            constant: entry.constant,
          })),
        }, null, 2)
      }
      if (file === 'author-note.md') return document.authorNote
      if (file === 'story.md') return document.storyNotes
      if (file === 'epochs.json') {
        return JSON.stringify({
          epochId: document.epochId,
          epochStartedAt: document.epochStartedAt,
          frozenEntryIds: document.frozenEntryIds,
          epochs: document.epochs,
        }, null, 2)
      }
      const id = loreId(file)
      if (id !== undefined) {
        const entry = document.lorebook.find(item => item.id === id)
        if (entry === undefined) throw new Error(`no lorebook entry ${JSON.stringify(id)} in project ${project}`)
        return entry.content
      }
      throw unknownPath(file)
    },
    async write(path: string, content: string, exec: InternalExec): Promise<string> {
      const project = projectOf(exec)
      const file = path.trim().replace(/^\/+/u, '')
      if (file === 'epochs.json') throw new Error('tavern://epochs.json is read-only; epochs are archived by rebuilding the frozen prefix')
      if (file === '') throw unknownPath(file)
      if (file !== 'author-note.md' && file !== 'story.md' && loreId(file) === undefined) {
        throw unknownPath(file)
      }
      const updated = await store.update(project, (document): TavernDocument => {
        if (file === 'author-note.md') return { ...document, authorNote: content }
        if (file === 'story.md') return { ...document, storyNotes: content }
        const id = loreId(file)!
        const entry = document.lorebook.find(item => item.id === id)
        if (entry === undefined) throw new Error(`no lorebook entry ${JSON.stringify(id)} in project ${project}`)
        return {
          ...document,
          lorebook: document.lorebook.map(item => item.id === id ? { ...item, content } : item),
        }
      })
      return `Updated tavern://${file} for project ${project} (revision ${updated.revision}).`
    },
  }
}
