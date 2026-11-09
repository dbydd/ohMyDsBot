/**
 * `omd-chat-shell` — the blank-session screen, laid out like a started one.
 *
 * dsh renders a fresh session in the `hero` phase: the composer stack is
 * centered in the column, with the product mark and headline above it and a
 * workspace row above the input card. Once the session has turns it switches to
 * the `active` phase and docks the same card at the bottom. This plugin hides
 * the hero chrome and docks the card for the blank case too, so the two screens
 * differ in content and not in geometry.
 *
 * The CSS lives in the browser half. The host half exists only because a client
 * bundle is created with no entry config of its own — `ClientEntries.create`
 * passes `{ name: id }` — so a validated `Config` value reaches the page the
 * same way upstream ships its own boot settings: one `webserver/index-inject`
 * global row, read once by the client factory. Without a page to serve, the
 * listener never fires and the plugin does nothing.
 *
 * @module omd-chat-shell
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Plugin id the Loader entry carries. */
export const name = 'omd-chat-shell'

/** Browser global the host publishes its validated config on. */
export const CONFIG_GLOBAL = '__DSH_CHAT_SHELL_CONFIG__'

/** Plugin configuration. */
export interface Config {
  /** Lay a blank session out like a started one: hide the hero chrome, dock the input card. */
  dockBlankComposer: boolean
}

export const Config: z<Config> = z.object({
  dockBlankComposer: z.boolean().default(true)
    .description('Hide the centered product mark, headline, and workspace row on a blank session and dock the input card at the bottom, matching a session that already has turns.'),
})

/** One row of the index injection table the web server renders into its page. */
interface ConfigInjection {
  kind: 'global'
  name: string
  value: { dockBlankComposer: boolean }
}

/**
 * Publish the browser half's only setting into the page it will be loaded on.
 * @param ctx - Host context; the web app emits `webserver/index-inject` while rendering its index.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table: ConfigInjection[]) => {
    table.push({
      kind: 'global',
      name: CONFIG_GLOBAL,
      value: { dockBlankComposer: config.dockBlankComposer },
    })
  })
}
