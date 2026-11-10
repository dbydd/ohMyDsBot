/**
 * The node's durable store: its trust rows, grants, threads, inbox and cursors outlive
 * the process, in the same data root as the identity key.
 *
 * A key file that survives a restart while every trust row evaporates is the bug this
 * module exists for: the remote peer still believes it exchanged keys and issued grants,
 * while this side answers as a stranger. The store therefore claims `durable` and lives
 * at `<dsh home>/data/omd-onlyne/`, one file per node identity.
 *
 * SQLite is the primary format (`node:sqlite`, available in Node 22.5+ and Bun). A host
 * whose runtime cannot load it falls back to the atomic JSON file; the choice is recorded
 * on the instance so a test can assert which one it got.
 *
 * @module omd-onlyne/storage
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Storage, Transaction } from '@onlyne/lib'

/** `<dsh home>/data/omd-onlyne`; `DSH_HOME` moves the root, which is how a test gets its own. */
export function dataRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'data', 'omd-onlyne')
}

/**
 * Where the shared listener remembers its port. A restart that asks the OS for a fresh
 * ephemeral port changes the node's address, and every peer's trust row then names a
 * socket that no longer exists; remembering the port keeps the address stable.
 */
export function listenerPortFile(): string {
  return join(dataRoot(), 'listener.json')
}

/** One node identity's store. The name is filesystem-safe and reversible for inspection. */
export function storageFile(nodeId: string): string {
  return join(dataRoot(), `storage-${Buffer.from(nodeId, 'utf8').toString('base64url')}.sqlite`)
}

/** Read the port a previous process used, if it recorded one. */
export function rememberedPort(file: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { port?: unknown }
    return typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 ? parsed.port : undefined
  } catch {
    return undefined
  }
}

/** Record the port this process bound, atomically and readable by the next one. */
export function rememberPort(file: string, port: number): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify({ port }, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/** The transaction view every backend implements; SQLite and JSON share it. */
interface Backend {
  readonly kind: 'sqlite' | 'json'
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>
  close(): void
}

type Changes = Map<string, unknown>

/** The slice of `node:sqlite`'s `DatabaseSync` this module uses, named so the import stays optional. */
interface SqliteConnection {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  close(): void
}

/**
 * The storage a node uses unless its host supplies one. `release()` is the other half of
 * {@link openNodeStorage}; the file closes when its last node disposes.
 */
export class DurableStorage implements Storage {
  readonly guarantee = 'durable' as const
  readonly backend: 'sqlite' | 'json'
  readonly path: string
  readonly #store: Backend
  readonly #close: () => void

  constructor(path: string, store: Backend, close: () => void) {
    this.path = path
    this.#store = store
    this.backend = store.kind
    this.#close = close
  }

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#store.run(work)
  }

  close(): void {
    this.#close()
  }
}

interface Held {
  readonly storage: DurableStorage
  refs: number
}

const held = new Map<string, Held>()

/**
 * Open (or join) the durable store for one node identity.
 *
 * Two nodes for the same identity in one process share one instance: the library
 * serializes each transaction, and two SQLite connections writing one file would merely
 * contend with each other.
 *
 * @param nodeId - identity the file is scoped to.
 * @returns the store; call {@link releaseNodeStorage} with the same id when the node ends.
 */
export async function openNodeStorage(nodeId: string): Promise<DurableStorage> {
  const path = storageFile(nodeId)
  const existing = held.get(path)
  if (existing !== undefined) {
    existing.refs += 1
    return existing.storage
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const store = await openBackend(path)
  const entry: Held = {
    storage: new DurableStorage(path, store, () => {
      const current = held.get(path)
      if (current === undefined) return
      current.refs -= 1
      if (current.refs > 0) return
      held.delete(path)
      store.close()
    }),
    refs: 1,
  }
  held.set(path, entry)
  return entry.storage
}

/** Drop one reference; the file closes with the last one. */
export function releaseNodeStorage(storage: Storage): void {
  if (storage instanceof DurableStorage) storage.close()
}

async function openBackend(path: string): Promise<Backend> {
  let DatabaseSync: new (file: string) => SqliteConnection
  try {
    // `node:sqlite` is absent before Node 22.5 and in some embedded runtimes, so the import
    // cannot be static: the fallback below is what keeps the plugin loadable there.
    ({ DatabaseSync } = await import('node:sqlite') as { DatabaseSync: new (file: string) => SqliteConnection })
  } catch {
    // No SQLite in this runtime: the atomic JSON file is the durable format instead.
    return jsonBackend(path)
  }
  // A store that exists but cannot be opened is a real failure; silently starting a second,
  // empty format beside it would strand the rows the previous process wrote.
  return sqliteBackend(path, new DatabaseSync(path))
}

function sqliteBackend(path: string, db: SqliteConnection): Backend {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  secure(path)
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  return {
    kind: 'sqlite',
    run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('The Onlyne store is closed.'))
      const run = async (): Promise<T> => {
        db.exec('BEGIN IMMEDIATE')
        const tx: Transaction = {
          async get<V>(key: string) {
            const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: unknown } | undefined
            return row?.value === undefined ? undefined : JSON.parse(String(row.value)) as V
          },
          async put<V>(key: string, value: V) {
            db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
              .run(key, JSON.stringify(value))
          },
          async delete(key: string) {
            db.prepare('DELETE FROM kv WHERE key = ?').run(key)
          },
          async scan<V>(prefix: string) {
            const rows = db.prepare('SELECT key, value FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key')
              .all(prefix.length, prefix) as Array<{ key?: unknown; value?: unknown }>
            return rows.map(row => ({ key: String(row.key), value: JSON.parse(String(row.value)) as V }))
          },
        }
        try {
          const value = await work(tx)
          db.exec('COMMIT')
          secure(path)
          return value
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* the transaction may already be gone */ }
          throw error
        }
      }
      const result = tail.then(run, run)
      tail = result.then(() => undefined, () => undefined)
      return result
    },
    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

/** The fallback store: one JSON object, rewritten atomically per commit. */
function jsonBackend(path: string): Backend {
  const file = jsonPath(path)
  const load = (): Map<string, unknown> => {
    if (!existsSync(file)) return new Map()
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return new Map(Object.entries(parsed))
  }
  let records = load()
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  return {
    kind: 'json',
    run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('The Onlyne store is closed.'))
      const run = async (): Promise<T> => {
        const changes: Changes = new Map()
        const deleted = new Set<string>()
        const tx: Transaction = {
          async get<V>(key: string) {
            if (deleted.has(key)) return undefined
            const value = changes.has(key) ? changes.get(key) : records.get(key)
            return value === undefined ? undefined : structuredClone(value) as V
          },
          async put<V>(key: string, value: V) {
            changes.set(key, structuredClone(value))
            deleted.delete(key)
          },
          async delete(key: string) {
            changes.delete(key)
            deleted.add(key)
          },
          async scan<V>(prefix: string) {
            const merged = new Map(records)
            for (const key of deleted) merged.delete(key)
            for (const [key, value] of changes) merged.set(key, value)
            return [...merged.entries()]
              .filter(([key]) => key.startsWith(prefix))
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, value]) => ({ key, value: structuredClone(value) as V }))
          },
        }
        const value = await work(tx)
        for (const key of deleted) records.delete(key)
        for (const [key, entry] of changes) records.set(key, entry)
        writeJson(file, records)
        return value
      }
      const result = tail.then(run, run)
      tail = result.then(() => undefined, () => undefined)
      return result
    },
    close() {
      if (closed) return
      closed = true
      records = new Map()
    },
  }
}

/** The JSON fallback lives beside the SQLite file, not on top of it. */
function jsonPath(path: string): string {
  return path.endsWith('.sqlite') ? `${path.slice(0, -'.sqlite'.length)}.json` : `${path}.json`
}

function writeJson(file: string, records: Map<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify(Object.fromEntries(records), null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/** Keep the store and its WAL sidecars owner-only, like the key file. */
function secure(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`, jsonPath(path)]) {
    if (!existsSync(file)) continue
    const mode = statSync(file).mode & 0o777
    if ((mode & 0o077) !== 0) chmodSync(file, 0o600)
  }
}
