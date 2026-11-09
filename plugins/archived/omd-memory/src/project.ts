/**
 * Project identity: which project a session belongs to, and therefore which
 * bank or tag its memories land in.
 *
 * One function answers this question for both the write path and the read path
 * (`projectIdentity`), because a project whose writes and reads disagree is
 * two disconnected memories. The anchor is the session's *effective* working
 * directory — a session may `cd` inside its lifetime — not the original project
 * recorded in the session header.
 *
 * @module omd-memory/project
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ResolvedConfig } from './config.ts'

/** A resolved project identity. */
export interface ProjectIdentity {
  /** Stable identity string, used in bank ids and in the `project:` tag. */
  id: string
  /** How the identity was derived. */
  basis: 'remote' | 'basename' | 'pin'
  /** Repository root the identity describes. */
  root: string
}

/**
 * Normalize a git remote URL so `git@host:org/repo.git`, `ssh://git@host/org/repo`
 * and `https://host/org/repo` all name the same project.
 * @param remote - the raw remote URL.
 * @returns `host/org/repo`, lowercased.
 */
export function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed)
  if (scp !== null) return `${scp[1]}/${scp[2]}`.toLowerCase()
  try {
    const url = new URL(trimmed)
    return `${url.hostname}${url.pathname}`.replace(/^\/+/, '').toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

/**
 * Turn any identity string into a bank-id-safe slug.
 * @param value - the raw identity.
 * @returns lowercase alphanumerics and dashes, at most 63 characters.
 */
export function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (normalized.length <= 63) return normalized === '' ? 'project' : normalized
  // Long remotes collide after truncation; a short digest keeps them distinct.
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `${normalized.slice(0, 54)}-${digest}`
}

/**
 * Read the git remote of a directory, walking up to the worktree root.
 * @param cwd - the session's effective directory.
 * @returns the normalized remote, or `undefined` outside a repository.
 */
async function readRemote(cwd: string): Promise<string | undefined> {
  let current = cwd
  for (;;) {
    try {
      const text = await readFile(`${current}/.git/config`, 'utf8')
      const match = /^\s*url\s*=\s*(.+)$/m.exec(text)
      if (match !== null) return normalizeRemote(match[1]!)
    } catch {
      // Not a repository at this level; keep walking.
    }
    const parent = current.replace(/\/[^/]+$/, '')
    if (parent === current || parent === '') return undefined
    current = parent
  }
}

/**
 * Resolve one session's project identity.
 * @param cwd - the session's effective working directory.
 * @param config - resolved configuration (strategy, pin, bank prefix).
 * @returns the identity; `pin` wins, then the git remote, then the basename.
 */
export async function projectIdentity(cwd: string, config: ResolvedConfig): Promise<ProjectIdentity> {
  if (config.projectIdStrategy === 'pin') {
    return { id: slug(config.projectId), basis: 'pin', root: cwd }
  }
  if (config.projectIdStrategy === 'remote') {
    const remote = await readRemote(cwd)
    if (remote !== undefined) return { id: slug(remote), basis: 'remote', root: cwd }
  }
  return { id: slug(basename(cwd)), basis: 'basename', root: cwd }
}

/**
 * The tag every memory of one project carries. Tagged routing is what makes
 * `scopeMode: 'domain-tagged'` separate projects inside one bank.
 * @param identity - the project identity.
 * @returns the tag, e.g. `project:github-com-org-repo`.
 */
export function projectTag(identity: ProjectIdentity): string {
  return `project:${identity.id}`
}

/**
 * The bank a project reads and writes under the configured scope mode.
 * @param identity - the project identity.
 * @param config - resolved configuration.
 * @returns the bank id.
 */
export function projectBank(identity: ProjectIdentity, config: ResolvedConfig): string {
  if (config.codingBank !== '') return config.codingBank
  return `${config.bankPrefix}-${identity.id}`
}
