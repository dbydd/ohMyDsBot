/**
 * `omd-project-config` — per-project parameters for the rest of omd.
 *
 * dsh's own configuration layers stop at the profile; nothing it ships varies
 * by working directory. This plugin adds that layer without touching dsh's
 * config system: a Host service resolves plugin defaults → the repository's
 * `.omd/config.json` → a personal override stored in a `ctx.storageDomain`
 * record keyed by project root, and publishes the result as `ctx.projectConfig`.
 * Consumers (`omd-hindsight`, `omd-task`, future role routing) read it through
 * `ctx.get('projectConfig')` and fall back to their own `Config` when absent.
 *
 * The browser half registers the panel that edits the personal layer.
 *
 * @module omd-project-config
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Config as ServiceConfig } from './schema.ts'
import {
  ProjectConfigServiceImpl,
  type DomainFacility,
  type ProjectConfigService,
} from './service.ts'

export type * from './schema.ts'
export type {
  DomainFacility,
  ProjectConfigChange,
  ProjectConfigListener,
  ProjectConfigService,
} from './service.ts'
export { ProjectConfigServiceImpl } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-project configuration; present only while this plugin is mounted. */
    projectConfig: ProjectConfigService
  }
}

/** Plugin id the Loader entry carries. */
export const name = 'omd-project-config'

/**
 * The storage domain is a hard dependency: the personal layer has no file
 * fallback. On a host without the storage stack this fiber never activates and
 * `ctx.projectConfig` is never provided — consumers see absence rather than a
 * silently degraded in-memory layer.
 */
export const inject = ['storageDomain']

/** Machine-wide defaults under the three project layers. */
export type Config = ServiceConfig

/** Schemastery configuration for those defaults. */
export const Config: z<Config> = z.object({
  memoryEnabled: z.boolean().default(false)
    .description('Default for memory.enabled when neither the repository file nor the personal override names it.'),
  memoryBank: z.string().default('')
    .description('Default for memory.bank; empty means derive the bank from the project path.'),
  memoryRecallTokens: z.natural().min(1).default(1500)
    .description('Default cap, in tokens, for one memory injection.'),
  delegationMaxActive: z.natural().min(1).default(4)
    .description('Default number of concurrently running subagents for our dispatcher; dsh subagent.maxActiveSubagents remains the process-wide hard cap.'),
})

/**
 * Publish the service and own the storage domain's lifetime.
 * @param ctx - plugin context with the storage facility.
 * @param config - validated machine-wide defaults.
 */
export function apply(ctx: Context, config: Config): void {
  const storage = ctx.get('storageDomain') as DomainFacility
  const service = new ProjectConfigServiceImpl(storage, Config(config))
  ctx.provide('projectConfig', service)
  ctx.effect(() => () => service.dispose(), 'omd-project-config: storage domain')
}
