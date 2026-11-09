/**
 * Browser half of `omd-read`: the conversation card for the `read` tool.
 *
 * dsh serves this file verbatim — the client half is not compiled — so it is
 * written as the artifact `@deepseek-ai/dsh-client-modules` consumes: one
 * `window.__ModuleLoader__.load({ id, factory })` registration whose factory
 * resolves imports through the shell's frozen module table and returns the
 * module body. `react` and `@deepseek-ai/dsh-client-ui-primitives` are platform
 * seeds, so no package edge is needed to reach them.
 *
 * Key and priority. The keyed slot dispatches on `entryKey: toolName`, the wire
 * tool name this package's host half registers (`defineTool({ name: 'read' })`),
 * so the key is `read` — not the plugin name. Upstream's own `read` row
 * occupies that same cell at the default priority 0; keyed cells shadow by
 * rank ("lowest renders"), so priority -1 is what replaces it, while a second
 * registration at priority 0 would throw at load.
 *
 * Dispatch. The host declares the card in `presentationMeta`, which dsh persists
 * as `tool/result.data.meta` — opaque to the core, absent from the model
 * surface, and reproduced verbatim on replay. This row reads `meta.kind` and
 * renders accordingly; it never parses the model-facing result text to guess a
 * card. Three kinds exist because `presentationMeta` runs only for a successful
 * execution: a failed call (and any record written before this tool declared a
 * card) has no meta, and that absence is the fallback path.
 *
 * - `text`: a file window, rendered through `ReadBlock` — the same
 *   line-numbered, syntax-highlighted primitive upstream's read card uses.
 * - `resource`: a `scheme://` read (for example `skill://…`), the same code
 *   view without a file to open.
 * - `image`: the official gallery through the `conversation.images.content`
 *   factory. That factory owns attachment URLs and the loader, so this row
 *   builds neither and declares no child slot (upstream's `read_image` row
 *   already owns `tool.call.images`).
 */

window.__ModuleLoader__.load({
  id: 'omd-read',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { createElement: h, Fragment, useMemo, useState } = React
    const {
      DisclosureRow, ReadBlock, TextShimmer,
      IconBrowseOutlineRegular, IconInspectOutlineRegular, languageForPath,
    } = primitives

    /** Wire name, and therefore the keyed dispatch value this entry claims. */
    const TOOL_NAME = 'read'
    /** Namespace providing the tool-row chrome (`tool.title.*`, `row.*`, `read.*`). */
    const LOCALE_NS = 'conversation'
    /** Chat-row geometry: upstream's read row shows this many lines before folding. */
    const CHAT_READ_MAX_LINES = 8
    const STYLE_OWNER = 'omd-read/toolview'

    const CSS = `
.omd-read-root { display: flex; flex-direction: column; }
.omd-read-leading { flex-shrink: 0; }
.omd-read-title { font-weight: 400; }
.omd-read-sep {
  flex: none;
  width: 2px;
  height: 2px;
  border-radius: 1px;
  margin: 0 8px;
  background: var(--dsw-alias-label-caption);
}
.omd-read-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.omd-read-fileLink {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  text-align: left;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: inherit;
  text-decoration: underline dotted;
  text-decoration-color: currentColor;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  cursor: pointer;
}
.omd-read-error { color: var(--dsw-alias-state-error-primary); }
.omd-read-stopped { color: var(--dsw-alias-state-warn-label); }
.omd-read-bodyWrap { display: flex; flex-direction: column; }
.omd-read-block, .omd-read-imageBody { margin: 4px 0 4px 4px; }
.omd-read-imageBody { display: flex; flex-direction: column; }
.omd-read-imageMeta {
  margin-top: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: var(--dsw-font-markdown-code-block-small);
  color: var(--dsw-alias-label-tertiary);
}
.omd-read-output {
  margin: 4px 0 4px 4px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: var(--dsw-font-markdown-code-block-small);
  color: var(--dsw-alias-label-secondary);
}
.omd-read-output[data-error] { color: var(--dsw-alias-state-error-primary); }
.omd-read-inspect {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 4px;
  margin: 4px 0 2px 4px;
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  cursor: pointer;
}
.omd-read-visuallyHidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.omd-read-card { display: flex; flex-direction: column; padding: 2px 0; }
`

    /** Install this row's stylesheet once; the plugin's fiber owns its lifetime. */
    function installStyles() {
      if (document.querySelector('style[data-plugin-css="omd-read/toolview"]') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.pluginCss = STYLE_OWNER
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    /** Whether a persisted value is a 1-based line number. */
    function positiveInteger(value) {
      return typeof value === 'number' && Number.isInteger(value) && value >= 1
    }

    /** The path the call authored, selector included (`src/a.ts:50-200`), verbatim. */
    function callPath(block) {
      const path = block.args.text('path')
      if (typeof path === 'string' && path.trim() !== '') return path
      const legacy = block.args.text('file_path')
      return typeof legacy === 'string' && legacy.trim() !== '' ? legacy : ''
    }

    /**
     * The window fields shared by the text and resource cards, or null when the
     * persisted meta does not describe one.
     */
    function readWindow(meta) {
      const { requested, offset, lines, totalLines, truncated } = meta
      if (typeof requested !== 'string' || requested === '') return null
      if (typeof totalLines !== 'number' || !Array.isArray(lines)) return null
      const window = []
      for (const line of lines) {
        if (typeof line !== 'object' || line === null) return null
        if (!positiveInteger(line.number) || typeof line.text !== 'string') return null
        window.push({ number: line.number, text: line.text })
      }
      return {
        requested,
        ...positiveInteger(offset) ? { offset } : {},
        lines: window,
        totalLines,
        truncated: truncated === true,
      }
    }

    /** The attachment reference an image card renders, or null when it is unusable. */
    function imageAttachment(image) {
      if (typeof image !== 'object' || image === null) return null
      if (typeof image.attachmentId !== 'string' || image.attachmentId === '') return null
      if (typeof image.mediaType !== 'string' || typeof image.bytes !== 'number') return null
      if (!positiveInteger(image.width) || !positiveInteger(image.height)) return null
      return image
    }

    /**
     * The card the host declared for a settled result, or null when it declared
     * none — a failed call records no meta, and neither did this tool's earlier
     * results, so both take the flattened-text path.
     */
    function readMeta(meta) {
      if (typeof meta !== 'object' || meta === null) return null
      if (meta.kind === 'image') {
        const image = imageAttachment(meta.image)
        if (image === null || typeof meta.requested !== 'string' || typeof meta.path !== 'string') return null
        return { kind: 'image', requested: meta.requested, path: meta.path, image }
      }
      if (meta.kind !== 'text' && meta.kind !== 'resource') return null
      const window = readWindow(meta)
      if (window === null) return null
      if (meta.kind === 'resource') {
        return typeof meta.scheme === 'string' && meta.scheme !== ''
          ? { kind: 'resource', scheme: meta.scheme, ...window }
          : null
      }
      return typeof meta.path === 'string' && meta.path !== '' ? { kind: 'text', path: meta.path, ...window } : null
    }

    /** Flatten a settled result for the rows that carry no declared card. */
    function resultText(node) {
      const parts = []
      for (const part of node.content) parts.push(part.type === 'text' ? part.text : JSON.stringify(part, null, 2))
      if (parts.length === 0 && node.error !== undefined) parts.push(`${node.error.name}: ${node.error.code}`)
      return parts.join('\n')
    }

    function firstLine(text) {
      const nl = text.indexOf('\n')
      return nl === -1 ? text : text.slice(0, nl)
    }

    /** Row lifecycle, read from the block's stage and settlement. */
    function rowState(block) {
      if (!('kind' in block)) return block.phase === 'preparing' ? 'preparing' : 'running'
      if (block.error?.code === 'interrupted') return 'stopped'
      return block.isError ? 'error' : 'ok'
    }

    /** Localized chrome for the shared read primitive. */
    function readLabels(t) {
      return {
        codeLabel: t('codeBlock.title'),
        wrapLabel: t('codeBlock.wrap'),
        unwrapLabel: t('codeBlock.unwrap'),
        window: (shown, total) => t('read.window', { shown, total }),
        copy: t('copy'),
        copied: t('copied'),
        collapseAria: t('read.collapseAria'),
        expandAria: hidden => t('read.expandAria', { count: hidden }),
        collapse: t('collapse'),
        expand: hidden => t('read.expandRest', { count: hidden }),
      }
    }

    /** One `width × height · bytes` line, noting the original size when downsampled. */
    function imageSizeLine(t, attachment) {
      const { width, height, bytes, originalDimensions } = attachment
      return originalDimensions === undefined
        ? t('row.imageSize', { width, height, bytes })
        : t('row.imageSizeDownscaled', {
          width,
          height,
          bytes,
          originalWidth: originalDimensions.width,
          originalHeight: originalDimensions.height,
        })
    }

    /** Visually hidden run-state label: the icon and shimmer carry no accessible state. */
    function stateLabel(state, t) {
      switch (state) {
        case 'preparing': return t('row.preparing')
        case 'running': return t('row.running')
        case 'error': return t('row.failed')
        case 'stopped': return t('row.stopped')
        default: return null
      }
    }

    /** Keep Enter/Space on the path link from bubbling into the row's toggle. */
    function stopKeyDown(event) {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
    }

    /** The expanded body for the declared card, or the flattened result when none was declared. */
    function ReadBody({ card, output, state, loadImage, renderFactorySlot, labels, inspect, t }) {
      const body = card === null
        ? h('div', { className: 'omd-read-output', 'data-error': state === 'error' || undefined }, output)
        : card.kind === 'image'
          ? h('div', { className: 'omd-read-imageBody' },
            renderFactorySlot('conversation.images.content', {
              images: [{ attachment: card.image }],
              loadImage,
              align: 'start',
            }),
            h('div', { className: 'omd-read-imageMeta' },
              h('div', null, card.path),
              h('div', null, imageSizeLine(t, card.image))))
          : h(ReadBlock, {
            label: card.kind === 'text' ? card.path : card.requested,
            lines: card.lines,
            totalLines: card.totalLines,
            lang: card.kind === 'text' ? languageForPath(card.path) : undefined,
            labels,
            maxLines: CHAT_READ_MAX_LINES,
            className: 'omd-read-block',
          })
      return h('div', { className: 'omd-read-bodyWrap' },
        body,
        inspect === undefined ? null : h('button', { type: 'button', className: 'omd-read-inspect', onClick: inspect },
          h(IconInspectOutlineRegular),
          t('row.inspect')))
    }

    /**
     * One `read` call: upstream's row chrome (browse icon, `Read` title, the
     * authored path as the openable summary) over the declared card.
     */
    function ReadRow(props) {
      const { block, openFile, inspect, useDisclosure, t, loadImage, renderFactorySlot } = props
      const { expanded, toggle } = useDisclosure()
      const state = rowState(block)
      const settled = 'kind' in block
      const card = settled ? readMeta(block.meta) : null
      const output = settled && card === null ? resultText(block) : null
      const authored = callPath(block)
      const summary = state === 'error' || state === 'stopped'
        ? firstLine(output ?? '')
        : card !== null ? card.requested : authored !== '' ? authored : block.callId
      const status = stateLabel(state, t)
      const labels = useMemo(() => readLabels(t), [t])
      const expandable = state !== 'preparing' && (card !== null || (output !== null && output !== ''))
      const open = expanded && expandable
      // Only an absolute resolved path is a file the host can open; a resource
      // name and a still-running authored path stay plain labels.
      const filePath = card !== null && card.kind === 'text' && card.path.startsWith('/') ? card.path : undefined
      const openAtLine = filePath !== undefined && openFile !== undefined
        ? (event) => {
          event.stopPropagation()
          if (card.offset === undefined) openFile(filePath)
          else openFile(filePath, { line: card.offset })
        }
        : undefined

      const collapsed = summary === '' ? null : h(Fragment, null,
        h('span', { className: 'omd-read-sep', 'data-shimmer-decoration': '', 'aria-hidden': true }),
        openAtLine === undefined
          ? h('span', {
            className: state === 'error' ? 'omd-read-error' : state === 'stopped' ? 'omd-read-stopped' : 'omd-read-summary',
          }, h(TextShimmer, null, summary))
          : h('button', { type: 'button', className: 'omd-read-fileLink', onClick: openAtLine, onKeyDown: stopKeyDown },
            h(TextShimmer, null, summary)))

      return h('div', { className: 'omd-read-root', 'data-state': state, 'data-tool': TOOL_NAME },
        status === null ? null : h('span', { className: 'omd-read-visuallyHidden' }, status),
        h(DisclosureRow, {
          rowClassName: 'omd-read-row',
          leadingClassName: 'omd-read-leading',
          titleClassName: 'omd-read-title',
          icon: h(IconBrowseOutlineRegular, { size: 14 }),
          title: t('tool.title.read'),
          running: state === 'running' || state === 'preparing',
          open,
          expandable,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: toggle,
          collapsedContent: collapsed,
        }, open
          ? h(ReadBody, { card, output, state, loadImage, renderFactorySlot, labels, inspect, t })
          : null))
    }

    // ---------------------------------------------------------------------
    // Read card in hosts that replace the tool-call row
    //
    // A host may shadow `conversation.chat.node` key `tool-call` with its own
    // renderer, and that renderer never reaches `tool.call.toolview`. DS-Bot
    // does exactly this. The card below is an independent conversation node
    // built from the same `presentationMeta` the toolview row reads, so a read
    // stays visible there without touching the host. It is built only while
    // the tool-call row is shadowed, so a plain dsh session keeps one card.

    /** Node kind this package contributes, and the slot key that draws it. */
    const CARD_KIND = 'omdReadCard'
    /** Priority a host uses when it replaces the default chat cells. */
    const SHADOW_PRIORITY = -100

    /**
     * Whether another plugin replaced the default tool-call row.
     * @param ctx - client plugin context carrying `slots`.
     * @returns true when the lowest tool-call priority is at or below the shadow mark.
     */
    function toolRowShadowed(ctx) {
      const entriesOfSlot = ctx.slots?.entriesOfSlot
      if (typeof entriesOfSlot !== 'function') return false
      const entries = entriesOfSlot.call(ctx.slots, 'conversation.chat.node') ?? []
      const own = entries.filter(entry => entry.options !== undefined && entry.options.key === 'tool-call')
      if (own.length === 0) return false
      return Math.min(...own.map(entry => entry.options.priority ?? 0)) <= SHADOW_PRIORITY
    }

    /**
     * The declared card on a settled read result, or null for any other event.
     * @param event - one session event.
     * @returns the payload and call identity, or null.
     */
    function readResult(event) {
      if (event.type !== 'tool/result') return null
      const data = event.data
      const meta = data !== null && typeof data === 'object' ? data.meta : null
      if (meta === null || typeof meta !== 'object') return null
      if (meta.kind !== 'text' && meta.kind !== 'resource' && meta.kind !== 'image') return null
      const callId = data.message?.toolCallId
      return {
        seq: event.seq,
        callId: typeof callId === 'string' ? callId : undefined,
        meta,
      }
    }

    /** Identity of one decorated read result. */
    function matchRead(event) {
      const found = readResult(event)
      return found === null ? null : { id: String(found.callId ?? found.seq), role: 'start' }
    }

    /** One record per read result; a later result for the same call replaces it. */
    function startRead(_context, matched) {
      return readResult(matched.event)
    }

    /** The row: the shared read chrome over the declared window. */
    function ReadCard({ node, t }) {
      const [open, setOpen] = useState(false)
      const data = node.data
      const meta = data.meta
      const labels = useMemo(() => readLabels(t), [t])
      const window = meta.kind === 'image' ? null : readWindow(meta)
      const summary = meta.kind === 'image' ? meta.path : window?.requested ?? meta.requested ?? ''
      const body = window === null
        ? h('div', { className: 'omd-read-output' }, summary)
        : h(ReadBlock, {
          label: meta.kind === 'text' ? meta.path : window.requested,
          lines: window.lines,
          totalLines: window.totalLines,
          lang: meta.kind === 'text' ? languageForPath(meta.path) : undefined,
          labels,
          maxLines: CHAT_READ_MAX_LINES,
          className: 'omd-read-block',
        })
      return h('div', { className: 'omd-read-card', 'data-tool': TOOL_NAME },
        h(DisclosureRow, {
          rowClassName: 'omd-read-row',
          leadingClassName: 'omd-read-leading',
          titleClassName: 'omd-read-title',
          icon: h(IconBrowseOutlineRegular, { size: 14 }),
          title: t('tool.title.read'),
          open,
          expandable: true,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: () => setOpen(value => !value),
          collapsedContent: summary === '' ? null : h(Fragment, null,
            h('span', { className: 'omd-read-sep', 'data-shimmer-decoration': '', 'aria-hidden': true }),
            h('span', { className: 'omd-read-summary' }, summary)),
        }, open ? body : null))
    }

    /** Services this half needs: the slot registry, the conversation, and locale. */
    exports.inject = ['slots', 'locale', 'uiConversation']

    /**
     * Install the row's stylesheet and claim the `read` toolview cell.
     * @param ctx - client plugin context carrying `slots`.
     */
    exports.apply = function apply(ctx) {
      ctx.effect(installStyles)
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: TOOL_NAME,
        priority: -1,
        locale: LOCALE_NS,
      }, ReadRow))
      ctx.uiConversation.events.register({
        kind: CARD_KIND,
        target: 'chat',
        match: matchRead,
        start: startRead,
        update: startRead,
        publication: () => 'immediate',
        buildViewNode(context) {
          const state = context.state
          if (state === null || typeof state !== 'object') return null
          if (!toolRowShadowed(ctx)) return null
          const location = context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' }
          return {
            key: context.key,
            id: context.id,
            kind: CARD_KIND,
            target: 'chat',
            anchorSeq: state.seq,
            location,
            visibility: 'visible',
            groupTree: 'turn',
            data: state,
          }
        },
      })
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: CARD_KIND,
        locale: LOCALE_NS,
      }, ReadCard))
    }

    return module.exports
  },
})
