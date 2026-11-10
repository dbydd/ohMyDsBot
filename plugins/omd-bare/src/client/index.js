// Browser half of omd-bare: remove the shell's side columns, keep its surfaces.
//
// The shipped frame sets `grid-template-columns` inline from a JS width solve,
// so the only way to collapse a track from CSS is an important rule on the
// frame itself. Everything else — conversation, composer, overlays, dialogs —
// keeps rendering through the shipped slots; nothing is unmounted.
window.__ModuleLoader__.load({
  id: '@dbydd/omd-bare',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const STYLE_ID = 'omd-bare-styles'
    const MARKER = 'omd-bare'

    const CSS = `
html[data-omd-bare] div:has(> [class*='sidebarCol']) {
  grid-template-columns: 0 minmax(0, 1fr) 0 !important;
}

html[data-omd-bare] [class*='sidebarCol'],
html[data-omd-bare] [class*='rightbarCol'],
html[data-omd-bare] [class*='handle'] {
  display: none !important;
}

html[data-omd-bare] [class*='centerCol'] {
  margin: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
}
`

    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    function apply(ctx) {
      ctx.effect(() => {
        document.documentElement.dataset.omdBare = ''
        return () => { delete document.documentElement.dataset.omdBare }
      }, 'omd-bare: marker')
      ctx.effect(installStyles, 'omd-bare: stylesheet')
      void MARKER
    }

    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
