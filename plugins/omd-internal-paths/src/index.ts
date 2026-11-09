/**
 * `omd-internal-paths` — internal paths as one extensible service.
 *
 * A data-owning plugin registers its source once, with the grammar it accepts
 * and a reader; the model side and the web side then address the same data
 * through the same syntax. `dsh-resource://<source>/<path>` is the canonical
 * form; `<source>://<path>` is accepted only for sources that declare
 * `shorthand`. Filesystem paths and `file://` stay outside this service: two
 * schemes that both mean "a file" is the bug this replaces.
 *
 * The browser half (`./client`) enumerates `sources()` and serves each source
 * as a `ctx.resources` protocol named after it, so `useResource` reads
 * `dsh-resource://<source>/…` without a second registry.
 *
 * Following. A source that declares `live: true` is followed by the browser
 * half: it re-reads the address on a timer and yields a frame only when the
 * content changed. The interval is a Host `Config` field (`livePollMs`) and
 * reaches the page as a `webserver/index-inject` global, because a client
 * bundle is created with no entry config of its own. Polling rather than a
 * Host push because the missing piece is change detection, not transport:
 * `InternalSource` exposes `read` only, so every source would have to grow a
 * subscription before a push could fire, while the Remote already carries
 * `mode: 'stream'` methods if a push is added later.
 *
 * @module omd-internal-paths
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { InternalPathsServiceImpl, type InternalPathsService } from './service.ts'

export type * from './parse.ts'
export { parseAddress, parseCanonical, parseShorthand } from './parse.ts'
export type * from './service.ts'
export { InternalPathsServiceImpl, performTextEdit, type PathPermissionRule } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Registered internal path sources; present only while this plugin is mounted. */
    internalPaths: InternalPathsService
  }
}

/** Plugin id the Loader entry carries. */
export const name = 'omd-internal-paths'

/** No host service is required: this plugin only publishes one. */
export const inject: string[] = []

/** Browser global the host publishes its validated config on. */
export const CONFIG_GLOBAL = '__DSH_INTERNAL_PATHS_CONFIG__'

/** Plugin configuration. */
export interface Config {
  /**
   * How often the web side re-reads a `live` source, in milliseconds. One
   * small local Remote call per open address per interval; the page receives a
   * frame only when the content changed. Read at page render, so a change
   * applies on the next reload.
   */
  livePollMs: number
  /** Path permission rules enforced at backend. */
  permissions?: import('./service.ts').PathPermissionRule[]
}

/** One row of the index injection table the web server renders into its page. */
interface ConfigInjection {
  kind: 'global'
  name: string
  value: { livePollMs: number }
}

/** Values are published into every rendered page; an omitted row keeps the defaults. */
export const Config: z<Config> = z.object({
  livePollMs: z.number().step(1).min(100).default(1500)
    .description('Interval at which the web side re-reads a source that declares live data, in milliseconds.'),
  permissions: z.array(z.object({
    agent: z.string().description('Target agent name or session id'),
    path: z.string().required().description('Path prefix or pattern'),
    action: z.string().default('*').description('Action: read, write, edit, or *'),
    access: z.string().default('allow').description('Access: allow, deny, or read-only'),
  })).default([])
    .description('Backend-enforced path permission rules by agent and path.'),
})

/**
 * Publish the registry and own its lifetime.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const service = new InternalPathsServiceImpl()
  if (Array.isArray(config.permissions)) {
    for (const rule of config.permissions) {
      service.setPermission(rule)
    }
  }
  ctx.provide('internalPaths', service)
  ctx.effect(() => () => service.dispose(), 'omd-internal-paths: sources')
  ctx.on('webserver/index-inject', (table: ConfigInjection[]) => {
    table.push({
      kind: 'global',
      name: CONFIG_GLOBAL,
      value: { livePollMs: config.livePollMs },
    })
  })
}
