/**
 * Smoke-only helpers re-exported from the plugin internals. Kept separate from
 * `src/index.ts` so the plugin entry never ships test-only exports.
 */

/** Split a tools source path the way the `tools` source does. */
export function parseToolsPath(path: string): { sessionId?: string; tool?: string; file?: string } {
  const parts = path.replace(/^\/+/u, '').split('/').filter(part => part.length > 0)
  return { sessionId: parts[0], tool: parts[1], file: parts[2] }
}
