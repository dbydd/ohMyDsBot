/**
 * Credential resolution, read fresh on every provider call.
 *
 * Order (first non-empty wins): the inherited process environment, then
 * `<dsh home>/.credentials.yaml`, then `.env` in the invocation directory. This
 * is the same ladder `dsh-credentials-local` layers, read directly so the
 * providers work when the plugin is mounted without the credentials service.
 *
 * Values are never logged, embedded in errors, or returned to a caller that did
 * not ask for them; a lookup that fails yields `undefined` rather than an empty
 * string, so `available()` cannot mistake a missing key for a usable one.
 *
 * @module omd-web-providers/keys
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Basename of the credentials document inside the harness home. */
const CREDENTIALS_FILENAME = '.credentials.yaml'

/** The `refs:` mapping key; entries under it are what a provider ref names. */
const REFS_SECTION = 'refs'

/** Strip one layer of matching single or double quotes and surrounding space. */
function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = trimmed.length >= 2
    && (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith('\'') && trimmed.endsWith('\''))
  return quoted ? trimmed.slice(1, -1).trim() : trimmed
}

/**
 * Parse a credentials document for flat `name: value` pairs.
 *
 * The document may indent entries under a `refs:` section, so the key is
 * trimmed and the section names themselves resolve to an empty value and drop
 * out. Values that are not scalars on one line (blocks, nested records) are
 * skipped rather than half-parsed.
 * @param text the document contents
 */
function parseFlatPairs(text: string): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    const value = unquote(line.slice(separator + 1))
    if (name === '' || value === '') continue
    if (name === 'version' || name === 'records' || name === REFS_SECTION) continue
    pairs.set(name, value)
  }
  return pairs
}

/** Read `~/.dsh/.credentials.yaml` (or `$DSH_HOME`), or `undefined` on any failure. */
function readCredentialsFile(): Map<string, string> | undefined {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    return parseFlatPairs(readFileSync(join(home, CREDENTIALS_FILENAME), 'utf8'))
  } catch {
    // Absent, unreadable, or not owner-only: a plugin must not fail the session
    // over a credential file it is only allowed to consult opportunistically.
    return undefined
  }
}

/** Read `NAME=value` pairs from `.env` in the invocation directory. */
function readDotEnv(): Map<string, string> | undefined {
  try {
    const pairs = new Map<string, string>()
    for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      const name = line.slice(0, separator).trim()
      const value = unquote(line.slice(separator + 1))
      if (name === '' || value === '') continue
      pairs.set(name, value)
    }
    return pairs
  } catch {
    return undefined
  }
}

/**
 * Resolve one credential reference to its secret value.
 *
 * Called per provider call rather than cached at construction, so a key rotated
 * into the environment or the credentials file takes effect without a restart.
 * @param ref the environment-variable-shaped reference, e.g. `JINA_API_KEY`
 * @returns the secret, or `undefined` when no layer supplies one
 */
export function resolveRef(ref: string): string | undefined {
  const fromEnv = process.env[ref]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return readCredentialsFile()?.get(ref) ?? readDotEnv()?.get(ref)
}

/**
 * True when a reference resolves to a non-empty value. This is the whole body
 * of every `available()`: a local check that never touches the network.
 * @param ref the credential reference to look up
 */
export function hasRef(ref: string): boolean {
  return resolveRef(ref) !== undefined
}
