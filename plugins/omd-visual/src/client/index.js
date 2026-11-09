// Browser half of omd-visual. Hand-authored because the web shell serves this
// file to the page as-is: a build step would need a bundler the plugin runtime
// does not require, so the module-loader factory is written directly. Only
// platform modules (react) are requested from the module table.
//
// One record, two Conversation nodes, in this order:
//
// - `omdVisualInline` re-emits a ready record as a `dshUiFences` node — the
//   node data shape the host UI plugin's own renderer consumes. It builds a
//   node only while that renderer is registered, so a profile without it gets
//   no empty seat at all.
// - `omdVisualSource` always builds a card: a collapsed source block for a
//   ready record, a status card otherwise. It is the reason a missing,
//   crashed, or upgraded renderer degrades to readable text instead of a blank
//   row. Both nodes share `anchorSeq = targetSeq`, and this Definition is
//   registered second so the rendered component sits above its source.
//
// Folding: every record carries the same `targetSeq`, so the Definition id is
// that number and the newest record for one id wins. `pending` therefore turns
// into `ready`/`failed`/`timeout` in place, without a second event type.
//
// Nothing here decides anything: the host already wrote the record, and these
// definitions only project it. No model call, no session write, no state.
window.__ModuleLoader__.load({
  id: 'omd-visual',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createElement: h } = React

    /** The record type the host half appends. */
    const RECORD_TYPE = 'plugin:omd/visual'
    /** Node kind keyed to the host UI plugin's fence renderer. */
    const FENCE_KIND = 'dshUiFences'
    /** Node kind keyed to this file's own card. */
    const CARD_KIND = 'omdVisualCard'
    /** Keyed slot every chat row is dispatched through. */
    const SLOT = 'conversation.chat.node'
    /** Locale namespace for this card's chrome. */
    const NS = 'omd.visual'
    const STYLE_OWNER = 'omd-visual/card'

    const en = {
      'card.title': 'Visualization',
      'card.source': 'source fence',
      'card.openWorker': 'Open worker session',
      'card.address': 'Address',
      'status.pending': 'running',
      'status.ready': 'ready',
      'status.failed': 'failed',
      'status.timeout': 'timed out',
      'status.skipped': 'skipped',
      'status.reason.pending': 'A worker is building the component.',
      'status.reason.failed': 'The worker could not deliver a component.',
      'status.reason.timeout': 'The worker did not finish in time.',
      'status.reason.skipped': 'Nothing was rendered for this answer.',
    }

    const zh = {
      'card.title': '可视化',
      'card.source': '源码',
      'card.openWorker': '打开工人会话',
      'card.address': '地址',
      'status.pending': '进行中',
      'status.ready': '就绪',
      'status.failed': '失败',
      'status.timeout': '超时',
      'status.skipped': '未生成',
      'status.reason.pending': '工人正在生成组件。',
      'status.reason.failed': '工人没能交付组件。',
      'status.reason.timeout': '工人没有在时限内完成。',
      'status.reason.skipped': '这条回答没有配图。',
    }

    const CSS = `
.omd-visual-root { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 2px; }
.omd-visual-source { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 2px 10px 6px; }
.omd-visual-source > summary { cursor: pointer; display: flex; align-items: baseline; gap: 8px; padding: 4px 0; }
.omd-visual-title { font-weight: 500; }
.omd-visual-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.omd-visual-code {
  margin: 4px 0 2px;
  max-height: 320px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base-secondary, var(--dsw-alias-bg-base));
  font: var(--dsw-font-markdown-code-block-small);
  white-space: pre;
}
.omd-visual-status { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 6px 10px; }
.omd-visual-status[data-status="failed"], .omd-visual-status[data-status="timeout"] {
  border-color: var(--dsw-alias-state-warn-label);
}
.omd-visual-statusHead { display: flex; align-items: baseline; gap: 8px; }
.omd-visual-badge { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.omd-visual-reason, .omd-visual-fallback { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); }
.omd-visual-foot { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
.omd-visual-address {
  font: var(--dsw-font-markdown-code-block-small);
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.omd-visual-open {
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
`

    /** Install this card's stylesheet once; the plugin's fiber owns its lifetime. */
    function installStyles() {
      if (document.querySelector('style[data-plugin-css="omd-visual/card"]') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.pluginCss = STYLE_OWNER
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    /** The stored record, normalized so one malformed payload cannot blank the row. */
    function normalize(data) {
      if (typeof data !== 'object' || data === null) return null
      if (typeof data.targetSeq !== 'number' || !Number.isFinite(data.targetSeq)) return null
      const props = typeof data.props === 'object' && data.props !== null ? data.props : {}
      const status = typeof data.status === 'string' ? data.status : 'failed'
      return {
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
        targetSeq: data.targetSeq,
        turn: typeof data.turn === 'number' ? data.turn : 0,
        step: typeof data.step === 'number' ? data.step : 0,
        status,
        reason: typeof data.reason === 'string' ? data.reason : undefined,
        props: {
          address: typeof props.address === 'string' ? props.address : '',
          fence: status === 'ready' && typeof props.fence === 'string' ? props.fence : undefined,
          title: typeof props.title === 'string' ? props.title : undefined,
          fallback: typeof props.fallback === 'string' ? props.fallback : undefined,
          childSessionId: typeof props.childSessionId === 'string' ? props.childSessionId : undefined,
          childMode: typeof props.childMode === 'string' ? props.childMode : 'unknown',
        },
      }
    }

    /** Whether the host UI plugin's fence renderer is currently registered. */
    function hasFenceRenderer(ctx) {
      return ctx.slots.entriesOfSlot(SLOT).some(entry => entry.options !== undefined && entry.options.key === FENCE_KIND)
    }

    /** Where a folded record's node belongs; the record carries `turn`/`step`, so this resolves. */
    function locationOf(context) {
      return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
    }

    /** Identity extractor: one Definition context per decorated assistant message. */
    function match(event) {
      if (event.type !== RECORD_TYPE) return null
      const data = event.data
      if (typeof data !== 'object' || data === null) return null
      if (typeof data.targetSeq !== 'number') return null
      return { id: String(data.targetSeq), role: 'start' }
    }

    /** Later records for one `targetSeq` replace earlier ones; every record is whole. */
    function start(_context, matched) {
      return normalize(matched.event.data)
    }

    /** One status card, or the ready record's own source fence. */
    function RecordCard({ node, t, openWorker }) {
      const record = node.data
      const ready = record.status === 'ready' && typeof record.props.fence === 'string'
      const child = record.props.childSessionId === undefined || openWorker === undefined
        ? null
        : h('button', {
          type: 'button',
          className: 'omd-visual-open',
          onClick: () => openWorker({
            parentSessionId: record.sessionId,
            childSessionId: record.props.childSessionId,
            mode: record.props.childMode,
          }),
        }, t('card.openWorker'))
      const address = record.props.address === ''
        ? null
        : h('code', { className: 'omd-visual-address' }, record.props.address)
      const footer = address === null && child === null
        ? null
        : h('div', { className: 'omd-visual-foot' }, address, child)
      if (ready) {
        return h('div', { className: 'omd-visual-root' },
          h('details', { className: 'omd-visual-source' },
            h('summary', null,
              h('span', { className: 'omd-visual-title' }, record.props.title ?? t('card.title')),
              h('span', { className: 'omd-visual-meta' }, t('card.source'))),
            h('pre', { className: 'omd-visual-code' }, record.props.fence),
            footer))
      }
      const reason = record.reason ?? t('status.reason.failed')
      return h('div', { className: 'omd-visual-root' },
        h('div', { className: 'omd-visual-status', 'data-status': record.status },
          h('div', { className: 'omd-visual-statusHead' },
            h('span', { className: 'omd-visual-title' }, t('card.title')),
            h('span', { className: 'omd-visual-badge' }, t(`status.${record.status}`))),
          h('p', { className: 'omd-visual-reason' }, reason),
          record.props.fallback === undefined ? null : h('p', { className: 'omd-visual-fallback' }, record.props.fallback),
          footer))
    }

    /**
     * Install both Definitions, the card seat, and the stylesheet.
     * @param ctx - client plugin context carrying the Conversation and Slot registries.
     */
    function apply(ctx) {
      ctx.effect(installStyles)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'omd-visual: dictionaries')

      // Registered first: equal anchorSeq keeps registration order, so the
      // rendered component stands above its source card.
      ctx.uiConversation.events.register({
        kind: 'omdVisualInline',
        target: 'chat',
        match,
        start,
        update: start,
        publication: () => 'immediate',
        buildViewNode(context) {
          const record = context.state
          if (record === null || typeof record !== 'object') return null
          if (record.status !== 'ready' || typeof record.props.fence !== 'string') return null
          if (!hasFenceRenderer(ctx)) return null
          return {
            key: context.key,
            id: context.id,
            kind: FENCE_KIND,
            target: 'chat',
            anchorSeq: record.targetSeq,
            location: locationOf(context),
            visibility: 'visible',
            groupTree: 'turn',
            data: {
              turn: record.turn,
              blocks: [{ step: record.step, index: 0, text: record.props.fence }],
              settled: true,
              everUi: true,
            },
          }
        },
      })

      ctx.uiConversation.events.register({
        kind: 'omdVisualSource',
        target: 'chat',
        match,
        start,
        update: start,
        publication: () => 'immediate',
        buildViewNode(context) {
          const record = context.state
          if (record === null || typeof record !== 'object') return null
          return {
            key: context.key,
            id: context.id,
            kind: CARD_KIND,
            target: 'chat',
            anchorSeq: record.targetSeq,
            location: locationOf(context),
            visibility: 'visible',
            groupTree: 'turn',
            data: record,
          }
        },
      })

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        key: CARD_KIND,
        locale: NS,
        inject: () => ({ openWorker: target => ctx.uiWorkspace.openSession(target) }),
      }, RecordCard))
    }

    exports.inject = ['slots', 'locale', 'uiConversation', 'uiWorkspace']
    exports.apply = apply
    return module.exports
  },
})
