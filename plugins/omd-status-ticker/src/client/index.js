// Browser half of omd-status-ticker: a two-line news-ticker band pinned to the
// top of the dsh web frame.
//
// Placement. The band registers into `shell.overlay`, the frame's list slot for
// a frame-wide surface of one's own (ui-layout's declaration calls it "the
// additive seat for a frame-wide surface of your own"). Every single-occupant
// seat that sits at the top — `conversation.header`, `conversation.session.
// header`, `conversation.session.header.corner`, `shell.leading` — is already
// taken, so registering there would replace that occupant. `shell.overlay` is a
// list: our id is added beside the shipped toasts and dialogs, and `order` only
// decides where among them we sit.
//
// A floating band would paint over the conversation title row and the sidebar's
// window strip, which is the whole top 52–76px of the frame. The layer takes no
// height, so this module reserves its own: while the band has rows it sets
// `html[data-omd-status-ticker]`, and the stylesheet below pads `#root` by the
// band's height. The frame (and every overlay inside it) then starts below the
// band, and no upstream surface is covered. When the band has no rows it renders
// nothing and the attribute is absent, so the frame keeps its full height.
//
// Data. One resource address, `dsh-resource://agents/<sessionId>`, provided by
// the host half (omd-agents-live). This module computes nothing that the source
// already reports; it only renders `agents`, `jobs`, `headline`, `metrics`, and
// advances the elapsed time locally at one second so the clock does not follow
// the poll period.
window.__ModuleLoader__.load({
  id: '@dbydd/omd-status-ticker',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const SLOT = 'shell.overlay'
    const ENTRY_ID = 'omd.status-ticker'
    const NS = 'omd.statusTicker'
    const ADDRESS = 'dsh-resource://agents/'
    const STYLE_ID = 'omd-status-ticker-styles'
    /** Row height, gap, padding and border the band's own height is computed from. */
    const ROW_HEIGHT = 16
    const ROW_GAP = 2
    const BAND_PADDING = 4
    const BAND_BORDER = 1
    /** Rendered height of a band carrying `count` rows; `#root` is padded by the same figure. */
    function bandHeight(count) {
      return BAND_PADDING + count * ROW_HEIGHT + Math.max(0, count - 1) * ROW_GAP + BAND_BORDER
    }
    /** Both lines, the fallback the stylesheet declares before the inline value lands. */
    const BAND_HEIGHT = bandHeight(2)
    /**
     * Statuses the source reports for work still in flight. Retention is the
     * source's business — a settled row stays on the ticker while the source
     * still lists it, and this module never re-adds one it dropped — so these
     * words only decide the order, never visibility.
     */
    const ACTIVE = new Set(['running', 'stopping', 'pending', 'starting', 'queued'])
    /** Scroll speed of the marquee, in px/s; the loop length follows the measured copy. */
    const SCROLL_SPEED = 40

    const en = {
      band: 'Live activity',
      agents: 'Agents',
      jobs: 'Jobs',
      'status.running': 'running',
      'status.stopping': 'stopping',
      'status.settled': 'settled',
      'status.completed': 'completed',
      'status.failed': 'failed',
      'status.cancelled': 'cancelled',
      'status.killed': 'killed',
      'status.queued': 'queued',
      'status.pending': 'pending',
      'status.starting': 'starting',
      'status.waiting': 'waiting',
    }

    const zh = {
      band: '实时活动',
      agents: '子代理',
      jobs: '后台作业',
      'status.running': '运行中',
      'status.stopping': '停止中',
      'status.settled': '已结束',
      'status.completed': '已完成',
      'status.failed': '失败',
      'status.cancelled': '已取消',
      'status.killed': '已终止',
      'status.queued': '排队',
      'status.pending': '等待',
      'status.starting': '启动中',
      'status.waiting': '等待中',
    }

    // Tokens. dsh publishes `--dsw-alias-*`; the semantic names this band's
    // markup uses are defined here, once, so the rest of the stylesheet never
    // names a palette. `currentColor` is the fallback for every one of them, so
    // a page that ships no theme still renders readable text.
    const CSS = `
html[data-omd-status-ticker] {
  /* Replaced inline with the height of the rows actually shown. */
  --omd-ticker-height: ${BAND_HEIGHT}px;
}

/* The band's own space, taken from the mount point rather than from the frame:
   the frame is a CSS-module class and its columns own their own heights. */
html[data-omd-status-ticker] #root {
  box-sizing: border-box;
  padding-top: var(--omd-ticker-height);
}

.omd-ticker {
  --fg: var(--dsw-alias-label-primary, currentColor);
  --muted: var(--dsw-alias-label-secondary, color-mix(in oklab, currentColor 62%, transparent));
  --border: var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 14%, transparent));
  --surface: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, transparent));
  --accent: var(--dsw-alias-state-business-primary, currentColor);
  --success: var(--dsw-alias-state-success-primary, currentColor);
  --warning: var(--dsw-alias-state-warn-primary, currentColor);
  --error: var(--dsw-alias-state-error-primary, currentColor);
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 24;
  box-sizing: border-box;
  height: var(--omd-ticker-height, ${BAND_HEIGHT}px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 2px 12px;
  overflow: hidden;
  background: var(--surface);
  color: var(--fg);
  border-bottom: 1px solid var(--border);
  font: 11px/16px system-ui, -apple-system, "Segoe UI", sans-serif;
  user-select: none;
}

/* macOS draws the traffic lights over the page at (16, 18); Windows draws the
   caption buttons at the top right. Only the free span carries text. */
html[data-platform='darwin'] .omd-ticker { padding-left: 84px; }
html[data-windows-titlebar] .omd-ticker { padding-right: 148px; }

.omd-ticker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  height: 16px;
}

.omd-ticker-row-label {
  flex: none;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: .04em;
}

.omd-ticker-viewport {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.omd-ticker-track {
  display: block;
  width: 100%;
  white-space: nowrap;
}

.omd-ticker-track[data-scroll='true'] {
  display: flex;
  align-items: center;
  width: max-content;
  animation-name: omd-ticker-scroll;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

/* Hovering the line stops it so a long activity string can be read. */
.omd-ticker-viewport:hover .omd-ticker-track[data-scroll='true'],
.omd-ticker-viewport:focus-within .omd-ticker-track[data-scroll='true'] {
  animation-play-state: paused;
}

@keyframes omd-ticker-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}

.omd-ticker-copy {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.omd-ticker-track[data-scroll='true'] .omd-ticker-copy {
  flex: none;
  width: auto;
  overflow: visible;
  text-overflow: clip;
}

.omd-ticker-track[data-scroll='true'] .omd-ticker-copy + .omd-ticker-copy {
  padding-left: 0;
}

.omd-ticker-segment {
  margin-right: 22px;
  white-space: nowrap;
}

.omd-ticker-segment:last-child {
  margin-right: 0;
}

.omd-ticker-name {
  font-weight: 600;
}

.omd-ticker-muted,
.omd-ticker-time,
.omd-ticker-note {
  color: var(--muted);
}

.omd-ticker-kind {
  color: var(--muted);
  margin-left: 6px;
}

.omd-ticker-status[data-status='running'] {
  color: var(--accent);
}

.omd-ticker-status[data-status='queued'],
.omd-ticker-status[data-status='pending'],
.omd-ticker-status[data-status='starting'],
.omd-ticker-status[data-status='stopping'],
.omd-ticker-status[data-status='waiting'] {
  color: var(--warning);
}

.omd-ticker-headline {
  color: var(--accent);
  font-weight: 600;
}

.omd-ticker-metric-label {
  color: var(--muted);
  margin-left: 6px;
}

.omd-ticker-delta[data-sign='up'] {
  color: var(--success);
}

.omd-ticker-delta[data-sign='down'] {
  color: var(--error);
}

@media (prefers-reduced-motion: reduce) {
  .omd-ticker-track[data-scroll='true'] {
    animation: none;
    display: block;
    width: 100%;
  }
  .omd-ticker-track[data-scroll='true'] .omd-ticker-copy {
    display: block;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .omd-ticker-track[data-scroll='true'] .omd-ticker-copy + .omd-ticker-copy {
    display: none;
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

    /** Whether a status is work in flight; only the order depends on this. */
    function isActive(status) {
      return ACTIVE.has(String(status ?? '').toLowerCase())
    }

    /** The status word as a dictionary entry, or the wire value itself. */
    function statusLabel(status, t) {
      const key = `status.${String(status ?? '').toLowerCase()}`
      const resolved = t(key)
      return resolved === key ? String(status ?? '') : resolved
    }

    /** A finite number, else undefined. */
    function finite(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    /** A short id for a row the source did not name. */
    function shortId(id) {
      const text = String(id ?? '')
      return text.length > 8 ? text.slice(0, 8) : text
    }

    /** One number as the ticker writes it: integers bare, others to `digits`. */
    function num(value, digits) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      return Number.isInteger(value) ? String(value) : value.toFixed(digits)
    }

    /** `▲5.7%`, `▼5.7%`, or '' when the reading carries no change. */
    function deltaText(delta) {
      const value = finite(delta)
      if (value === undefined || value === 0) return ''
      return `${value > 0 ? '▲' : '▼'}${num(Math.abs(value), 1)}%`
    }

    /** Elapsed time: seconds under a minute, then m/s and h/m. */
    function formatElapsed(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`
      return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
    }

    /**
     * Elapsed now: the frame's own figure plus the local second since it
     * arrived, so the clock does not follow the poll period. A settled row's
     * figure is frozen by the source, and a row with neither reading shows no
     * duration rather than a zero that would read as "started now".
     */
    function elapsedOf(entry, now, arrivedAt) {
      const reported = finite(entry.elapsedMs)
      const startedAt = finite(entry.startedAt)
      if (reported === undefined) {
        if (startedAt === undefined) return null
        if (!isActive(entry.status)) return Math.max(0, arrivedAt - startedAt)
        return Math.max(0, arrivedAt - startedAt) + Math.max(0, now - arrivedAt)
      }
      return isActive(entry.status) ? reported + Math.max(0, now - arrivedAt) : reported
    }

    /** The one-line activity summary, or '' when the source reported none. */
    function activityText(activity) {
      if (typeof activity === 'string') return activity
      if (activity === null || typeof activity !== 'object') return ''
      if (typeof activity.label === 'string' && activity.label !== '') return activity.label
      if (typeof activity.kind === 'string' && activity.kind !== '') return activity.kind
      return ''
    }

    /** The payload as an object, whether the source sent text or a value. */
    function parsePayload(value) {
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value)
          return parsed !== null && typeof parsed === 'object' ? parsed : null
        } catch {
          return null
        }
      }
      return value !== null && typeof value === 'object' ? value : null
    }

    /** In flight first, then the oldest start; ties keep the source's order. */
    function orderRows(rows) {
      const rank = row => (isActive(row?.status) ? 0 : 1)
      const start = row => finite(row?.startedAt) ?? 0
      return rows
        .filter(row => row !== null && typeof row === 'object')
        .map((row, index) => ({ row, index }))
        .sort((left, right) => rank(left.row) - rank(right.row)
          || start(left.row) - start(right.row)
          || left.index - right.index)
        .map(entry => entry.row)
    }

    /**
     * What the band draws: the two lists, already ordered, plus the clock
     * anchor. `generatedAt` is the source's own stamp — the instant its
     * `elapsedMs` figures were computed — so the local second is added from
     * there and network delay never inflates or trims the clock.
     */
    function shapeRows(value) {
      const payload = parsePayload(value)
      if (payload === null) return { at: Date.now(), agents: [], jobs: [] }
      return {
        at: finite(payload.generatedAt) ?? Date.now(),
        agents: Array.isArray(payload.agents) ? orderRows(payload.agents) : [],
        jobs: Array.isArray(payload.jobs) ? orderRows(payload.jobs) : [],
      }
    }

    /** The full text of one segment, for `title` and for length-independent fitting. */
    function segmentText(entry, kind, now, arrivedAt, t) {
      const parts = []
      if (kind === 'agents') {
        const headline = entry.headline
        if (headline !== null && typeof headline === 'object') {
          if (typeof headline.label === 'string') parts.push(headline.label)
          const delta = deltaText(headline.delta)
          if (delta !== '') parts.push(delta)
          if (typeof headline.note === 'string' && headline.note !== '') parts.push(headline.note)
        }
        parts.push(String(entry.name ?? shortId(entry.id)))
      } else {
        parts.push(String(entry.label ?? shortId(entry.id)))
        if (typeof entry.kind === 'string' && entry.kind !== '') parts.push(entry.kind)
      }
      parts.push(statusLabel(entry.status, t))
      const elapsed = elapsedOf(entry, now, arrivedAt)
      if (elapsed !== null) parts.push(formatElapsed(elapsed))
      const activity = activityText(entry.activity)
      if (activity !== '') parts.push(activity)
      const metrics = Array.isArray(entry.metrics) ? entry.metrics : []
      for (const metric of metrics) {
        if (metric === null || typeof metric !== 'object') continue
        parts.push([String(metric.label ?? ''), num(metric.value, 2), String(metric.unit ?? '')]
          .filter(part => part !== '')
          .join(' '))
        const delta = deltaText(metric.delta)
        if (delta !== '') parts.push(delta)
      }
      return parts.filter(part => part !== '').join(' · ')
    }

    /** One headline cluster: its reading, its change, and its note. */
    function Headline({ headline }) {
      return h('span', { className: 'omd-ticker-headline' }, [
        h('span', { key: 'label' }, String(headline.label ?? '')),
        deltaText(headline.delta) === ''
          ? null
          : h('span', {
            key: 'delta',
            className: 'omd-ticker-delta',
            'data-sign': finite(headline.delta) > 0 ? 'up' : 'down',
          }, ` ${deltaText(headline.delta)}`),
        typeof headline.note === 'string' && headline.note !== ''
          ? h('span', { key: 'note', className: 'omd-ticker-note' }, ` (${headline.note})`)
          : null,
      ])
    }

    /** One metric: `mpsnr 40.20 dB ▼5.7%`. */
    function Metric({ metric }) {
      const body = [num(metric.value, 2), String(metric.unit ?? '')].filter(part => part !== '').join(' ')
      const delta = deltaText(metric.delta)
      return h('span', { className: 'omd-ticker-metric' }, [
        h('span', { key: 'label', className: 'omd-ticker-metric-label' }, String(metric.label ?? '')),
        body === '' ? null : h('span', { key: 'value' }, ` ${body}`),
        delta === ''
          ? null
          : h('span', {
            key: 'delta',
            className: 'omd-ticker-delta',
            'data-sign': finite(metric.delta) > 0 ? 'up' : 'down',
          }, ` ${delta}`),
      ])
    }

    /** One row of the band: name, status, clock, activity, then metrics. */
    function Segment({ entry, kind, now, arrivedAt, t }) {
      const children = []
      if (kind === 'agents') {
        if (entry.headline !== null && typeof entry.headline === 'object'
          && (entry.headline.label !== undefined || entry.headline.note !== undefined)) {
          children.push(h(Headline, { key: 'headline', headline: entry.headline }), ' · ')
        }
        children.push(h('span', { key: 'name', className: 'omd-ticker-name' }, String(entry.name ?? shortId(entry.id))))
      } else {
        children.push(h('span', { key: 'name', className: 'omd-ticker-name' }, String(entry.label ?? shortId(entry.id))))
        if (typeof entry.kind === 'string' && entry.kind !== '') {
          children.push(h('span', { key: 'kind', className: 'omd-ticker-kind' }, entry.kind))
        }
      }
      const elapsed = elapsedOf(entry, now, arrivedAt)
      children.push(
        h('span', { key: 'status-sep', className: 'omd-ticker-muted' }, ' · '),
        h('span', {
          key: 'status',
          className: 'omd-ticker-status',
          'data-status': String(entry.status ?? '').toLowerCase(),
        }, statusLabel(entry.status, t)),
        elapsed === null
          ? null
          : h('span', { key: 'time', className: 'omd-ticker-time' }, ` ${formatElapsed(elapsed)}`),
      )
      const activity = activityText(entry.activity)
      if (activity !== '') {
        children.push(h('span', {
          key: 'activity',
          className: 'omd-ticker-activity',
          title: activity,
        }, ` · ${activity}`))
      }
      const metrics = Array.isArray(entry.metrics) ? entry.metrics : []
      for (let index = 0; index < metrics.length; index += 1) {
        const metric = metrics[index]
        if (metric === null || typeof metric !== 'object') continue
        children.push(h(Metric, { key: `metric-${index}`, metric }))
      }
      return h('span', { className: 'omd-ticker-segment' }, children)
    }

    /**
     * Width of the content against the width of the window it scrolls in.
     * `scrollWidth` reports the full content even while the copy is clipped to
     * the viewport, so one measurement answers both states.
     *
     * The copy is exactly as wide as the viewport while idle, so its own box
     * never reports content growth: a longer activity string overflows a box
     * that keeps its size. The content inside it is therefore what gets
     * followed — text and node changes through `MutationObserver`, box changes
     * of those elements and of the viewport through `ResizeObserver` — and
     * every callback re-measures. `setFit` keeps the previous object when both
     * numbers match, so a row whose content did not change never re-renders and
     * never restarts its animation.
     */
    function useFit() {
      const viewportRef = React.useRef(null)
      const copyRef = React.useRef(null)
      const [fit, setFit] = React.useState({ window: 0, content: 0 })
      React.useLayoutEffect(() => {
        const viewport = viewportRef.current
        const copy = copyRef.current
        if (viewport === null || copy === null) return undefined
        const measure = () => {
          const next = { window: viewport.clientWidth, content: copy.scrollWidth }
          setFit(previous => (previous.window === next.window && previous.content === next.content ? previous : next))
        }
        const resize = new ResizeObserver(measure)
        const watch = root => {
          if (root.nodeType !== Node.ELEMENT_NODE) return
          resize.observe(root)
          for (const element of root.querySelectorAll('*')) resize.observe(element)
        }
        const unwatch = root => {
          if (root.nodeType !== Node.ELEMENT_NODE) return
          resize.unobserve(root)
          for (const element of root.querySelectorAll('*')) resize.unobserve(element)
        }
        const mutation = new MutationObserver(records => {
          for (const record of records) {
            for (const node of record.addedNodes) watch(node)
            for (const node of record.removedNodes) unwatch(node)
          }
          measure()
        })
        resize.observe(viewport)
        watch(copy)
        mutation.observe(copy, { childList: true, characterData: true, subtree: true })
        measure()
        return () => {
          resize.disconnect()
          mutation.disconnect()
        }
      }, [])
      return { viewportRef, copyRef, fit }
    }

    /** `prefers-reduced-motion`, live: switching it stops a running band. */
    function useReducedMotion() {
      const query = '(prefers-reduced-motion: reduce)'
      const [reduced, setReduced] = React.useState(() => window.matchMedia(query).matches)
      React.useEffect(() => {
        const media = window.matchMedia(query)
        const onChange = event => { setReduced(event.matches) }
        setReduced(media.matches)
        media.addEventListener('change', onChange)
        return () => { media.removeEventListener('change', onChange) }
      }, [])
      return reduced
    }

    /** One line: a fixed label and a marquee that stops on hover. */
    function Row({ label, entries, kind, now, arrivedAt, reduced, t }) {
      const { viewportRef, copyRef, fit } = useFit()
      const scrolling = !reduced && fit.content > fit.window + 1
      const seconds = Math.max(10, Math.round(fit.content / SCROLL_SPEED))
      const segment = entry => h(Segment, { key: String(entry.id ?? ''), entry, kind, now, arrivedAt, t })
      const copy = (key, hidden) => h('div', {
        key,
        ref: hidden ? undefined : copyRef,
        className: 'omd-ticker-copy',
        'aria-hidden': hidden ? 'true' : undefined,
        title: scrolling ? undefined : entries.map(entry => segmentText(entry, kind, now, arrivedAt, t)).join(' · '),
      }, entries.map(segment))
      return h('div', { className: 'omd-ticker-row', 'data-kind': kind }, [
        h('span', { key: 'label', className: 'omd-ticker-row-label' }, label),
        h('div', { key: 'viewport', ref: viewportRef, className: 'omd-ticker-viewport' },
          h('div', {
            className: 'omd-ticker-track',
            'data-scroll': scrolling ? 'true' : 'false',
            style: scrolling ? { animationDuration: `${seconds}s` } : undefined,
          }, [
            copy('first', false),
            scrolling ? copy('second', true) : null,
          ])),
      ])
    }

    /**
     * The band itself. Mounted only while at least one row has a live entry, so
     * the attribute and the height reservation enter and leave together.
     */
    function Band({ agents, jobs, now, arrivedAt, t }) {
      const reduced = useReducedMotion()
      const rows = []
      if (agents.length > 0) rows.push(h(Row, { key: 'agents', kind: 'agents', label: t('agents'), entries: agents, now, arrivedAt, reduced, t }))
      if (jobs.length > 0) rows.push(h(Row, { key: 'jobs', kind: 'jobs', label: t('jobs'), entries: jobs, now, arrivedAt, reduced, t }))
      const height = `${bandHeight(rows.length)}px`
      React.useEffect(() => {
        const root = document.documentElement
        root.setAttribute('data-omd-status-ticker', '')
        root.style.setProperty('--omd-ticker-height', height)
        return () => {
          root.removeAttribute('data-omd-status-ticker')
          root.style.removeProperty('--omd-ticker-height')
        }
      }, [height])
      return h('div', {
        className: 'omd-ticker',
        role: 'group',
        'aria-label': t('band'),
        style: { height },
      }, rows)
    }

    /** The session the main view is showing, which is the one the band reports on. */
    function mainSessionId(state) {
      if (state === null || typeof state !== 'object' || !Array.isArray(state.ids)) return undefined
      for (const id of state.ids) {
        const row = state.byId?.[id]
        if ((row?.retainedBy?.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    /** The slot component: resolve the address, follow it, and render or nothing. */
    function StatusTicker({ useSessions, useResource, t }) {
      const sessionId = typeof useSessions === 'function' ? useSessions(mainSessionId) : undefined
      const snapshot = typeof useResource === 'function'
        ? useResource(sessionId === undefined ? '' : `${ADDRESS}${sessionId}`)
        : { status: 'none', value: undefined }
      // One frame per value: the live source yields only on change, so a new
      // value string is a new reading and brings its own clock anchor.
      const frame = React.useMemo(() => shapeRows(snapshot.value), [snapshot.value])
      const active = frame.agents.length > 0 || frame.jobs.length > 0
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!active) return undefined
        setNow(Date.now())
        const timer = setInterval(() => { setNow(Date.now()) }, 1000)
        return () => { clearInterval(timer) }
      }, [active])
      if (!active) return null
      return h(Band, {
        agents: frame.agents,
        jobs: frame.jobs,
        now,
        arrivedAt: frame.at,
        t,
      })
    }

    /**
     * Install the stylesheet and the band.
     * @param ctx - client plugin context carrying the slot and locale registries.
     */
    function apply(ctx) {
      ctx.effect(installStyles, 'omd-status-ticker: stylesheet')
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'omd-status-ticker: dictionaries')
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ENTRY_ID,
        // First among the frame's overlays: this band owns the top edge and the
        // others are toasts and dialogs, which belong above it in the stack.
        order: -100,
        locale: NS,
      }, StatusTicker))
    }

    exports.inject = ['slots', 'locale', 'resources']
    exports.apply = apply
    return module.exports
  },
})
