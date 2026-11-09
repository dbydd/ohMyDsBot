/**
 * Browser half of `omd-chat-shell`: the stylesheet that makes a blank session
 * look like a started one.
 *
 * dsh serves this file verbatim — there is no TypeScript build for the client
 * half — so it is written as the artifact `@deepseek-ai/dsh-client-modules`
 * consumes: one `window.__ModuleLoader__.load({ id, factory })` registration
 * whose factory returns the module body. It asks the module table for nothing:
 * the whole body is one `<style>` tag plus its lifetime.
 *
 * Selector contract:
 * - `[data-phase]` sits on the conversation root, `[data-conversation-scroll]`
 *   on the scroll body, `[data-composer-seat]` on the seat wrapping the input
 *   card. Those three are stable data attributes.
 * - `[class*='composerHero']` is a CSS-module local name. It is the only place
 *   this stylesheet depends on a class name, and it is the one that breaks
 *   silently when upstream renames the rule; README.md records how to notice.
 *   The stack it names has four children in hero phase: the product-mark
 *   block, the workspace row, the `conversation.input.dock` slot, and the input
 *   card. Only the first two are hidden.
 *
 * Config. A client bundle is created without its package's entry config, so
 * the host half publishes the validated value as a global (see
 * `src/index.ts`). `dockBlankComposer: false` means this module installs
 * nothing.
 */

window.__ModuleLoader__.load({
  id: 'omd-chat-shell',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    /** Browser global the host half publishes its config on. */
    const CONFIG_GLOBAL = '__DSH_CHAT_SHELL_CONFIG__'
    /** Fixed id: a second apply replaces nothing, because the tag is found and kept. */
    const STYLE_ID = 'omd-chat-shell'

    const CSS = `
[data-phase='hero'] [data-conversation-scroll] { justify-content: flex-end !important; }
[data-phase='hero'] [class*='composerHero'] { padding-bottom: 0 !important; }
[data-phase='hero'] [class*='composerHero'] > :nth-child(1),
[data-phase='hero'] [class*='composerHero'] > :nth-child(2) { display: none !important; }
[data-phase='hero'] [data-composer-seat] { padding-bottom: 12px !important; }
`

    /**
     * Whether the layout override is enabled. The host publishes the value at
     * page render; a page without that row keeps the default (`true`).
     */
    function dockBlankComposer() {
      const config = globalThis[CONFIG_GLOBAL]
      return !(config !== null && typeof config === 'object' && config.dockBlankComposer === false)
    }

    /** Install the stylesheet once; the plugin's fiber owns its removal. */
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    /**
     * Install the layout override.
     * @param ctx - client plugin context; `effect` ties the tag to the fiber.
     */
    exports.apply = function apply(ctx) {
      if (!dockBlankComposer()) return
      ctx.effect(installStyles)
    }

    return module.exports
  },
})
