// Browser half of omd-workbench — milestone 1: our own top bar.
//
// The bar is a fixed strip above the shipped frame, registered into
// `shell.overlay` (the frame-wide list slot). It reserves its own height by
// padding `#root`, the same mechanism omd-status-ticker uses, and stacks below
// the ticker through `--omd-ticker-height` instead of fighting it.
//
// The bar owns no session state. It reads the browser title (the shell already
// projects the selected session's title into it) and calls the shell's own
// service `uiWorkspace.startSession` in the native Agent surface.
// That keeps this module replaceable — a later workbench can take over the
// title and tabs without touching the conversation.
window.__ModuleLoader__.load({
  id: '@dbydd/omd-workbench',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const SLOT = 'shell.overlay'
    const ENTRY_ID = 'omd.workbench'
    const STYLE_ID = 'omd-workbench-styles'
    const NS = 'omd-workbench'
    const BAR_HEIGHT = 38
    /** Browser title separator the shell uses: `${session} — ${product}`. */
    const TITLE_SEPARATOR = ' — '

    const zh = {
      brand: '工作台',
      newSession: '+ 新会话',
    }

    const en = {
      brand: 'WORKBENCH',
      newSession: '+ New Session',
    }

    const CSS = `
html[data-omd-workbench] {
  --omd-workbench-height: ${BAR_HEIGHT}px;
}

/* Reserve both strips: ours plus whatever the ticker claims above it. The
   ticker pads #root on its own; this rule composes the two and wins because it
   states the sum. */
html[data-omd-workbench] #root {
  box-sizing: border-box;
  padding-top: calc(var(--omd-ticker-height, 0px) + var(--omd-workbench-height)) !important;
}

html[data-omd-workbench] .bt-leftcol,
html[data-omd-workbench] .bt-panel,
html[data-omd-workbench] .bt-pane {
  top: max(var(--dsh-frame-chrome-top, 0px), calc(var(--omd-ticker-height, 0px) + var(--omd-workbench-height))) !important;
}

/* Below the shell's collapse width the conversation takes the first grid track,
   and the Bot column is the only thing left beside it, so the transcript would
   start under a rail or drawer. DS Bot's rail is 88px wide; an open column is
   wider and carries its own offset. */
@media (max-width: 1023px) {
  html[data-omd-workbench] body:has(.bt-leftcol[data-left='rail']) [class*='centerCol'] {
    margin-left: 96px !important;
  }
}

.omd-wb {
  position: fixed;
  inset: 0 0 auto 0;
  top: var(--omd-ticker-height, 0px);
  z-index: 25;
  box-sizing: border-box;
  height: var(--omd-workbench-height);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  background: var(--dsw-specific-sidebar-fill, #141519);
  color: var(--dsw-alias-label-primary, #e9e8e4);
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  user-select: none;
}

.omd-wb-brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary, #a4a39e);
  letter-spacing: 0.04em;
}

.omd-wb-brand-mark {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 6px;
  background: var(--dsw-alias-state-business-primary, #9fe3a6);
  color: #0b0c0e;
  font-weight: 700;
  font-size: 11px;
}

.omd-wb-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #e9e8e4);
  font-weight: 500;
}

.omd-wb-sep {
  width: 1px;
  height: 14px;
  background: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
}

.omd-wb-grow {
  flex: 1;
  min-width: 0;
}

.omd-wb-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #a4a39e);
  font: inherit;
  cursor: pointer;
}

.omd-wb-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--dsw-alias-label-primary, #e9e8e4);
}

.omd-wb-button:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, #9fe3a6);
  outline-offset: 1px;
}

.omd-wb-button[data-kind='primary'] {
  color: var(--dsw-alias-label-primary, #e9e8e4);
  border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
}

body:has(.bt-side) .omd-wb-button[data-kind='primary'] {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .omd-wb-button { transition: none; }
}
`

    /** Install the stylesheet once; the fiber owns its lifetime. */
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    /** The selected session title the shell projects into `document.title`. */
    function sessionTitle() {
      const raw = document.title
      const cut = raw.indexOf(TITLE_SEPARATOR)
      return cut === -1 ? raw : raw.slice(0, cut)
    }

    /** Subscribe to browser-title changes; returns the unsubscribe. */
    function observeTitle(onChange) {
      if (typeof MutationObserver === 'undefined') return () => {}
      let last = sessionTitle()
      const target = document.querySelector('title') || document.head
      if (!target) return () => {}
      const observer = new MutationObserver(() => {
        const next = sessionTitle()
        if (next !== last) {
          last = next
          onChange(next)
        }
      })
      observer.observe(target, { subtree: true, childList: true, characterData: true })
      return () => observer.disconnect()
    }

    /** One top bar: brand, session title, and the shell actions we can call. */
    function Workbench(props) {
      const [title, setTitle] = React.useState(sessionTitle)
      const t = props.t || ((k) => (zh[k] || k))

      React.useEffect(() => observeTitle(setTitle), [])

      return h('div', { className: 'omd-wb' },
        h('span', { className: 'omd-wb-brand' },
          h('span', { className: 'omd-wb-brand-mark' }, '❯'),
          h('span', null, t('brand')),
        ),
        h('span', { className: 'omd-wb-sep' }),
        h('span', { className: 'omd-wb-title', title }, title),
        h('span', { className: 'omd-wb-grow' }),
        h('button', {
          type: 'button',
          className: 'omd-wb-button',
          'data-kind': 'primary',
          title: t('newSession'),
          onClick: () => props.workspace?.startSession?.(),
        }, t('newSession')),
      )
    }

    /**
     * Install the bar and reserve its height.
     * @param ctx - Client plugin context carrying the slot registry.
     */
    function apply(ctx) {
      ctx.effect(installStyles, 'omd-workbench: stylesheet')
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'omd-workbench: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        document.documentElement.dataset.omdWorkbench = ''
        return () => { delete document.documentElement.dataset.omdWorkbench }
      }, 'omd-workbench: marker')
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ENTRY_ID,
        order: 100,
        locale: NS,
      }, () => h(Workbench, {
        workspace: ctx.get('uiWorkspace'),
        t,
      })))
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
