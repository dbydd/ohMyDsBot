/**
 * The process-wide Ed25519 identity key, persisted under the dsh data root.
 *
 * Every node of this process shares one key: one operator owns the process, and
 * one key keeps the trust rows a peer holds valid across restarts. The file is
 * minted once with `generateKeyMaterial()` and re-read afterwards; `DSH_HOME`
 * moves the data root, which is how a test gets an identity of its own.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateKeyMaterial, keyFingerprint } from '@onlyne/lib'
import type { KeyHook, KeyMaterial } from '@onlyne/lib'

/** Where the key file lives: `<dsh home>/data/omd-onlyne/key.json`. */
export function keyFilePath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'data', 'omd-onlyne', 'key.json')
}

interface StoredKey {
  /** PKCS#8 DER, base64. */
  private_key: string
  /** Raw Ed25519 public value, base64. */
  public_key: string
  created_at: string
}

const materials = new Map<string, Promise<KeyMaterial>>()
const fingerprints = new Map<string, Promise<string>>()

function readStored(path: string): KeyMaterial {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredKey>
  if (typeof parsed.private_key !== 'string' || typeof parsed.public_key !== 'string') {
    throw new Error(`The Onlyne key file at ${path} is malformed; delete it to mint a new identity.`)
  }
  return {
    private_key: new Uint8Array(Buffer.from(parsed.private_key, 'base64')),
    public_key: new Uint8Array(Buffer.from(parsed.public_key, 'base64')),
  }
}

function writeStored(path: string, material: KeyMaterial): void {
  const stored: StoredKey = {
    private_key: Buffer.from(material.private_key).toString('base64'),
    public_key: Buffer.from(material.public_key).toString('base64'),
    created_at: new Date().toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

function load(path: string): Promise<KeyMaterial> {
  const known = materials.get(path)
  if (known !== undefined) return known
  const pending = (async () => {
    if (existsSync(path)) return readStored(path)
    const material = generateKeyMaterial()
    writeStored(path, material)
    return material
  })()
  materials.set(path, pending)
  pending.catch(() => materials.delete(path))
  return pending
}

/** The key hook every node receives. The material is resolved once per data root. */
export function processKeyHook(): KeyHook {
  const path = keyFilePath()
  const hook = (): Promise<KeyMaterial> => load(path)
  hook.replace = async (next: KeyMaterial) => {
    // Only `trust.rotate` calls this. Writing the rotated key keeps the file
    // and the protocol in step; the fingerprint cache is dropped with it.
    writeStored(path, next)
    materials.set(path, Promise.resolve(next))
    fingerprints.delete(path)
  }
  return hook
}

/** The key's fingerprint, resolved once per data root. */
export function processKeyFingerprint(): Promise<string> {
  const path = keyFilePath()
  const known = fingerprints.get(path)
  if (known !== undefined) return known
  const pending = load(path).then(material => keyFingerprint(material.public_key))
  fingerprints.set(path, pending)
  return pending
}

/** Whether the stored private key derives the stored public key; used by the smoke test. */
export function publicKeyOf(privateDer: Uint8Array): Uint8Array {
  const jwk = createPublicKey(createPrivateKey({ key: Buffer.from(privateDer), format: 'der', type: 'pkcs8' }))
    .export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('The Ed25519 public key could not be derived.')
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'))
}
