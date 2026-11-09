/**
 * Hand-written frontmatter and directory scanning for `omd-agents`.
 *
 * The format matches omp's agent files so an existing `~/.omp/agent/agents`
 * set keeps working unmodified: `---` opens the block, `key: value` lines
 * follow, list fields accept either a comma-separated string or a YAML
 * sequence, and everything after the closing `---` is the instructions.
 *
 * @module omd-agents/frontmatter
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDefinition } from './types.ts'

/** One parsed definition plus the file it came from, for error messages. */
export interface LoadedAgent {
  /** The parsed definition. */
  definition: AgentDefinition
  /** Absolute path of the markdown file. */
  path: string
}

/** A scanned agent file that failed validation, reported by the loader. */
export interface AgentLoadError {
  /** Absolute path of the file. */
  path: string
  /** Why the file was rejected. */
  reason: string
}

/** Result of scanning both agent directories. */
export interface ScanResult {
  /** Valid definitions, ordered by name. */
  agents: LoadedAgent[]
  /** Files rejected for a reason other than a duplicate name. */
  errors: AgentLoadError[]
}

/** Names that would collide with the harness's own agent sentinels. */
const RESERVED_NAMES = new Set(['main', 'sub'])

/**
 * Split a markdown document into its frontmatter entries and body.
 *
 * A document without an opening `---` line parses as an empty frontmatter and
 * the whole text as body; the caller rejects it for the missing `name`.
 *
 * @param text the file contents
 * @returns the frontmatter entries in file order and the body after the closing delimiter
 */
export function splitFrontmatter(text: string): { fields: Array<[string, string]>; body: string } {
  const fields: Array<[string, string]> = []
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { fields, body: text }

  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      close = index
      break
    }
  }
  if (close < 0) return { fields, body: text }

  let pendingIndex = -1
  for (const line of lines.slice(1, close)) {
    // A YAML sequence item continues the previous key's list.
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && pendingIndex >= 0) {
      const [key, previous] = fields[pendingIndex] ?? ['', '']
      const value = item[1] ?? ''
      fields[pendingIndex] = [key, previous.length === 0 ? value : `${previous}, ${value}`]
      continue
    }
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (entry === null) continue
    const key = entry[1] ?? ''
    const raw = (entry[2] ?? '').trim()
    pendingIndex = raw.length === 0 ? fields.length : -1
    fields.push([key, unquote(raw)])
  }
  return { fields, body: lines.slice(close + 1).join('\n') }
}

/**
 * Strip one layer of matching quotes and the YAML escapes that appear inside
 * double quotes. Unquoted values are returned trimmed but otherwise untouched.
 *
 * @param raw the value text after the colon
 * @returns the scalar value
 */
export function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\nt])/g, (_match, escape: string) => {
      if (escape === 'n') return '\n'
      if (escape === 't') return '\t'
      return escape
    })
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/**
 * Parse a list field. An empty value yields an empty array; a comma-separated
 * string and a YAML sequence (already folded by the reader) parse the same way.
 *
 * @param raw the frontmatter value, if present
 * @returns the trimmed, non-empty entries
 */
export function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const items = raw
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0)
  return items
}

/**
 * Parse a boolean field, accepting the spellings YAML and omp both produce.
 *
 * @param raw the frontmatter value, if present
 * @returns the boolean, or undefined when absent or unrecognized
 */
export function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'no' || value === 'off' || value === '0') return false
  return undefined
}

/**
 * Turn one markdown document into a definition.
 *
 * @param text the file contents
 * @param path absolute path, used only in the instructions' diagnostics
 * @param source which directory the file came from
 * @returns the definition, or the reason the file is unusable
 */
export function parseAgentDocument(
  text: string,
  path: string,
  source: 'user' | 'project',
): { definition: AgentDefinition } | { reason: string } {
  const { fields, body } = splitFrontmatter(text)
  // First occurrence wins, matching how a duplicate key inside one file reads.
  const field = (key: string): string | undefined => fields.find(([name]) => name === key)?.[1]
  const name = field('name')?.trim() ?? ''
  const description = field('description')?.trim() ?? ''
  if (name.length === 0) return { reason: `${path}: frontmatter is missing "name"` }
  if (description.length === 0) return { reason: `${path}: frontmatter is missing "description"` }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return { reason: `${path}: agent name "${name}" is reserved by the harness` }
  }

  const tools = parseList(field('tools'))
  const model = field('model')?.trim()
  const thinkingLevel = (field('thinking-level') ?? field('thinkingLevel'))?.trim()
  const parsedSpawns = parseList(field('spawns'))
  // omp spells "may spawn anything" as `*`; the catalog spells it by omitting the field.
  const spawns = parsedSpawns?.length === 1 && parsedSpawns[0] === '*' ? undefined : parsedSpawns
  const blocking = parseBoolean(field('blocking'))
  const output = field('output')?.trim()

  const definition: AgentDefinition = {
    name,
    description,
    instructions: body.trim(),
    source,
    ...(tools === undefined ? {} : { tools }),
    ...(model === undefined || model.length === 0 ? {} : { model }),
    ...(thinkingLevel === undefined || thinkingLevel.length === 0 ? {} : { thinkingLevel }),
    ...(spawns === undefined ? {} : { spawns }),
    ...(blocking === undefined ? {} : { blocking }),
    ...(output === undefined || output.length === 0 ? {} : { output }),
  }
  return { definition }
}

/**
 * Scan one directory for `*.md` agent files.
 *
 * A missing directory is an empty directory; an unreadable file is reported in
 * `errors` rather than aborting the whole catalog.
 *
 * @param directory absolute directory path
 * @param source which directory class this is
 * @param result the accumulator both directories write into
 */
function scanDirectory(
  directory: string,
  source: 'user' | 'project',
  result: ScanResult,
): void {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    result.errors.push({ path: directory, reason: String(error) })
    return
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue
    const path = join(directory, entry)
    let text: string
    try {
      if (!statSync(path).isFile()) continue
      text = readFileSync(path, 'utf8')
    } catch (error) {
      result.errors.push({ path, reason: String(error) })
      continue
    }
    const parsed = parseAgentDocument(text, path, source)
    if ('reason' in parsed) {
      result.errors.push({ path, reason: parsed.reason })
      continue
    }
    result.agents.push({ definition: parsed.definition, path })
  }
}

/**
 * Load every agent definition from the user and project directories.
 *
 * The result is sorted by name; duplicates and unusable files are returned by
 * {@link detectDuplicates} and reported by the caller.
 *
 * @param cwd project working directory, whose `.dsh/agents` is the project layer
 * @param home user home directory, whose `.dsh/agent/agents` is the user layer
 * @returns valid agents and per-file load errors
 */
export function scanAgents(cwd: string, home: string): ScanResult {
  const result: ScanResult = { agents: [], errors: [] }
  scanDirectory(join(home, '.dsh', 'agent', 'agents'), 'user', result)
  scanDirectory(join(cwd, '.dsh', 'agents'), 'project', result)
  result.agents.sort((a, b) => (a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0))
  return result
}

/**
 * Find names defined more than once.
 *
 * @param agents the scanned agents
 * @returns one message per duplicated name, naming every file that used it
 */
export function detectDuplicates(agents: readonly LoadedAgent[]): string[] {
  const pathsByName = new Map<string, string[]>()
  for (const agent of agents) {
    const paths = pathsByName.get(agent.definition.name) ?? []
    paths.push(agent.path)
    pathsByName.set(agent.definition.name, paths)
  }
  const duplicates: string[] = []
  for (const [name, paths] of pathsByName) {
    if (paths.length > 1) duplicates.push(`agent "${name}" is defined by ${paths.join(' and ')}`)
  }
  return duplicates
}
