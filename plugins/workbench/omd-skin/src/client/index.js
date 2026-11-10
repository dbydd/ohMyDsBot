// Browser half of omd-skin: one global stylesheet, injected once per mount.
//
// This is a whole-surface migration, not a set of per-component patches. Every
// rule is scoped to one column (sidebarCol / centerCol / rightbarCol), to a
// data attribute the shell owns ([data-composer-seat], [data-ds-dark-theme]),
// or to a markdown class. That scoping is the contract: a component may be
// restyled only through the seat that owns it, so a change here cannot leak
// into an unrelated surface.
//
// Class names are CSS-module locals inside a per-build hash
// (`pI_x6G_sidebarCol`), so rules match the local name. Prefer distinctive
// locals (`composerSeat`, `newSession`, `sidebarCol`); never match bare
// `_card` / `_row` / `_header` outside a column scope — those locals repeat in
// every package and would collide.
window.__ModuleLoader__.load({
  id: '@dbydd/omd-skin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const STYLE_ID = 'omd-skin-styles'
    const SKIN = 'tern'

    // Tern's palette relationships rather than its sampled hexes: the reference
    // window is translucent over a bright desktop, so its absolute values are
    // wallpaper-dependent. What carries over is near-black surfaces separated by
    // hairlines, muted warm text, one mint accent, and generous radii.
    const CSS = `
/* ============================================================
   1. Tokens
   ============================================================ */
html[data-omd-skin='tern'] {
  --omd-canvas: #eef0f2;
  --omd-base: #fcfcfc;
  --omd-sidebar: #f7f7f7;
  --omd-raise: #eeeeee;
  --omd-raise-2: #e5e7e9;
  --omd-deep: #f2f3f5;
  --omd-line: rgba(20, 20, 20, 0.08);
  --omd-line-2: rgba(20, 20, 20, 0.15);
  --omd-text: #141414;
  --omd-text-2: #565752;
  --omd-text-3: #71706b;
  --omd-mint: #237849;
  --omd-blue: #285ba6;

  --dsw-radius-xs: 4px !important;
  --dsw-radius-sm: 6px !important;
  --dsw-radius-md: 10px !important;
  --dsw-radius-lg: 14px !important;
  --dsw-radius-panel: 18px !important;
}

html[data-omd-skin='tern']:has(body[data-ds-dark-theme]) {
  --omd-canvas: #08090b;
  --omd-base: #121316;
  --omd-sidebar: #141519;
  --omd-raise: #1a1b21;
  --omd-raise-2: #202127;
  --omd-deep: #0e0f12;
  --omd-line: rgba(255, 255, 255, 0.065);
  --omd-line-2: rgba(255, 255, 255, 0.10);
  --omd-text: #e9e8e4;
  --omd-text-2: #a4a39e;
  --omd-text-3: #71706b;
  --omd-mint: #9fe3a6;
  --omd-blue: #93b7f7;
}

body[data-ds-dark-theme] {
  --dsw-alias-bg-base: var(--omd-base) !important;
  --dsw-alias-bg-layer-1: var(--omd-raise) !important;
  --dsw-alias-bg-layer-2: var(--omd-raise-2) !important;
  --dsw-alias-bg-layer-3: #26272d !important;
  --dsw-alias-bg-overlay: #1b1c21 !important;
  --dsw-specific-sidebar-fill: var(--omd-sidebar) !important;
  --dsw-alias-border-l1: var(--omd-line) !important;
  --dsw-alias-border-l2: var(--omd-line-2) !important;
  --dsw-alias-border-l3: rgba(255, 255, 255, 0.07) !important;
  --dsw-alias-border-l4: rgba(255, 255, 255, 0.14) !important;
  --dsw-alias-label-primary: var(--omd-text) !important;
  --dsw-alias-label-secondary: var(--omd-text-2) !important;
  --dsw-alias-label-tertiary: var(--omd-text-3) !important;
  --dsw-alias-label-caption: #7e7d78 !important;
  --dsw-alias-brand-primary: var(--omd-mint) !important;
  --dsw-alias-link: var(--omd-blue) !important;
  --dsw-alias-state-success-primary: var(--omd-mint) !important;
  --dsw-alias-state-warn-primary: #e6c07b !important;
  --dsw-alias-state-error-primary: #e07a72 !important;
  --dsw-alias-state-idle-primary: var(--omd-text-3) !important;
  --dsw-alias-state-business-primary: var(--omd-mint) !important;
  --dsw-alias-state-business-tertiary: rgba(159, 227, 166, 0.14) !important;
  --dsw-alias-button-info-fill: var(--omd-mint) !important;
  --dsw-alias-button-info-hover: #b7efbc !important;
  --dsw-alias-button-elevated-fill: #1a1b20 !important;
  --dsw-alias-interactive-bg-hover-accent: rgba(159, 227, 166, 0.1) !important;
  --dsw-alias-markdown-code-block: #0d0e11 !important;
  --dsw-alias-markdown-code-block-banner: #121317 !important;
  --dsw-focus-ring-color: var(--omd-mint) !important;
  --dsw-alias-scrollbar-bg-l2: transparent !important;
  --dsw-alias-scrollbar-hover-l2: rgba(255, 255, 255, 0.16) !important;
}

/* ============================================================
   2. Canvas — the app becomes a window on a darker desk
   ============================================================ */
html[data-omd-skin='tern'],
html[data-omd-skin='tern'] body {
  background: var(--omd-canvas) !important;
}

html[data-omd-skin='tern'] body {
  box-sizing: border-box !important;
  padding: 10px !important;
  -webkit-font-smoothing: antialiased;
}

html[data-omd-skin='tern'] body > #root {
  height: 100% !important;
}

html[data-omd-skin='tern'] div:has(> [class*='sidebarCol']) {
  overflow: hidden !important;
  border: 1px solid var(--omd-line) !important;
  border-radius: 16px !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 30px 80px -24px rgba(0, 0, 0, 0.85) !important;
}

/* ============================================================
   3. Columns — sidebar flush, two floating panes
   ============================================================ */
html[data-omd-skin='tern'] [class*='sidebarCol'] {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.022), rgba(255, 255, 255, 0) 180px),
    var(--omd-sidebar) !important;
  border-right: 1px solid var(--omd-line) !important;
  font-size: 12.5px;
  letter-spacing: 0.01em;
}

html[data-omd-skin='tern'] [class*='centerCol'] {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.018), rgba(255, 255, 255, 0) 160px),
    var(--omd-base) !important;
  margin: 8px;
  overflow: hidden !important;
  border: 1px solid var(--omd-line) !important;
  border-radius: 14px !important;
}

html[data-omd-skin='tern'] [class*='rightbarCol'] {
  background: var(--omd-deep) !important;
  margin: 8px 8px 8px 0;
  overflow: hidden !important;
  border: 1px solid var(--omd-line) !important;
  border-radius: 14px !important;
}

html[data-omd-skin='tern'] [class*='bottomRow'] {
  background: var(--omd-deep) !important;
  border-top: 1px solid var(--omd-line) !important;
  padding: 0 12px;
  box-sizing: border-box;
}

/* ============================================================
   4. Sidebar
   ============================================================ */
html[data-omd-skin='tern'] [class*='logoRow'] {
  height: 60px !important;
  margin-bottom: 8px !important;
  padding: 6px 0 !important;
}

html[data-omd-skin='tern'] [class*='brandName'] {
  font-size: 16px !important;
}

html[data-omd-skin='tern'] [class*='newSession'] {
  height: 34px !important;
  border-radius: 10px !important;
  font-size: 13px !important;
}

html[data-omd-skin='tern'] [class*='panelRow'] {
  min-height: 32px !important;
}

html[data-omd-skin='tern'] [class*='sidebarCol'] [class*='sectionLabel'] {
  font-size: 10.5px !important;
  font-weight: 500 !important;
  letter-spacing: 0.09em !important;
  text-transform: uppercase;
  color: var(--omd-text-3) !important;
}

html[data-omd-skin='tern'] [class*='sidebarCol'] [class*='sessionRow'] {
  min-height: 30px !important;
  border-radius: 8px !important;
}

html[data-omd-skin='tern'] [class*='sidebarCol'] [class*='projectRow'] {
  min-height: 28px !important;
  border-radius: 8px !important;
}

html[data-omd-skin='tern'] [class*='sidebarCol'] [class*='selected'] {
  background: rgba(255, 255, 255, 0.06) !important;
}

html[data-omd-skin='tern'] [class*='footArea'] {
  border-top: 1px solid var(--omd-line);
}

/* ============================================================
   5. Conversation header and tabs
   ============================================================ */
html[data-omd-skin='tern'] [class*='centerCol'] [class*='tabs'] {
  gap: 18px;
}

html[data-omd-skin='tern'] [class*='centerCol'] [class*='tabActive'] {
  letter-spacing: 0.02em;
}

/* ============================================================
   6. Transcript
   ============================================================ */
html[data-omd-skin='tern'] [data-conversation-scroll] [class*='callRow'] {
  border-radius: 10px;
  transition: background-color 120ms ease;
}

html[data-omd-skin='tern'] [data-conversation-scroll] [class*='callRow']:hover {
  background: rgba(255, 255, 255, 0.025);
}

html[data-omd-skin='tern'] [data-conversation-scroll] [class*='_card'],
html[data-omd-skin='tern'] [data-conversation-scroll] [class*='ioCard'] {
  background: var(--omd-raise) !important;
  border: 1px solid var(--omd-line) !important;
  border-radius: 12px !important;
  box-shadow: none !important;
}

html[data-omd-skin='tern'] [data-conversation-scroll] [class*='bubble'] {
  background: var(--omd-raise) !important;
  color: var(--omd-text) !important;
  border-radius: 14px !important;
}

html[data-omd-skin='tern'] [data-conversation-scroll] [class*='summary'] {
  color: var(--omd-text-2) !important;
}

html[data-omd-skin='tern'] [data-conversation-scroll] [class*='prose'] {
  color: var(--omd-text) !important;
  line-height: 1.7 !important;
}

html[data-omd-skin='tern'] .md-code-block {
  border: 1px solid var(--omd-line) !important;
  border-radius: 12px !important;
  background: var(--omd-deep) !important;
}

html[data-omd-skin='tern'] [data-conversation-scroll] pre {
  background: var(--omd-deep) !important;
  border-radius: 12px;
}

/* ============================================================
   7. Composer
   ============================================================ */
html[data-omd-skin='tern'] [data-composer-seat] [class*='_card'] {
  background: var(--omd-raise) !important;
  border-radius: 14px !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 0 0 1px rgba(255, 255, 255, 0.06),
    0 24px 56px -16px rgba(0, 0, 0, 0.7) !important;
}

/* ============================================================
   8. Right pane
   ============================================================ */
html[data-omd-skin='tern'] [class*='rightbarCol'] [class*='_row'] {
  border-radius: 8px;
  transition: background-color 120ms ease;
}

html[data-omd-skin='tern'] [class*='rightbarCol'] [class*='_row']:hover {
  background: rgba(255, 255, 255, 0.04) !important;
}

/* ============================================================
   9. Selection, scrollbars, focus
   ============================================================ */
html[data-omd-skin='tern'] ::selection {
  background: rgba(159, 227, 166, 0.24) !important;
  color: #f4f3ef;
}

html[data-omd-skin='tern'] * {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.12) transparent;
}

html[data-omd-skin='tern'] ::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

html[data-omd-skin='tern'] ::-webkit-scrollbar-track {
  background: transparent;
}

html[data-omd-skin='tern'] ::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
  background-clip: padding-box;
}

html[data-omd-skin='tern'] ::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.18);
  background-clip: padding-box;
}

@media (prefers-reduced-motion: reduce) {
  html[data-omd-skin='tern'] [data-conversation-scroll] [class*='callRow'],
  html[data-omd-skin='tern'] [class*='rightbarCol'] [class*='_row'] {
    transition: none;
  }
}
`

    /** Install the stylesheet once; the plugin's fiber owns its lifetime. */
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    /**
     * Mark the document and install the sheet.
     * @param ctx - Client plugin context; only `effect` is used.
     */
    function apply(ctx) {
      ctx.effect(() => {
        document.documentElement.dataset.omdSkin = SKIN
        return () => { delete document.documentElement.dataset.omdSkin }
      }, 'omd-skin: marker')
      ctx.effect(installStyles, 'omd-skin: stylesheet')
    }

    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
