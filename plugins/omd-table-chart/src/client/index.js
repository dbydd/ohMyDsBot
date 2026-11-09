// Browser half of omd-table-chart. Hand-authored because the web shell serves
// this file to the page as-is; only `react` is requested from the module table.
//
// The host already wrote one record per assistant message, carrying the whole
// ChartSpec. This file folds that record into a chat row and draws it:
//
// - `omdChartSpec` matches `plugin:omd/table-chart` events, keyed by
//   `anchorSeq`, so fold order does not matter and a refresh, fork, or resume
//   reproduces the chart from the log alone.
// - `omdChartCard` is the `conversation.chat.node` view under that anchor. It
//   draws `bar`, `line`, `stacked`, and `grouped` as an SVG in `currentColor`
//   with opacity steps, so light and dark themes both read without a hard-coded
//   background. Every other kind renders its title plus one sentence saying it
//   is not drawn yet; nothing is blank and nothing throws.
//
// No state, no session write, no model call: rendering is a pure projection of
// the record.
window.__ModuleLoader__.load({
  id: 'omd-table-chart',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createElement: h } = React

    /** The record type the host half appends. */
    const RECORD_TYPE = 'plugin:omd/table-chart'
    /** Node kind this file registers as the chart's view. */
    const CARD_KIND = 'omdChartCard'
    /** Keyed slot every chat row is dispatched through. */
    const SLOT = 'conversation.chat.node'
    /** Locale namespace for this card's chrome. */
    const NS = 'omd.chart'
    const STYLE_OWNER = 'omd-table-chart/card'

    /** Kinds this renderer draws; everything else takes the explicit notice. */
    const SUPPORTED = new Set(['bar', 'line', 'stacked', 'grouped'])

    /** Series fills, from the first series down. Opacity keeps the palette theme-neutral. */
    const SERIES_OPACITY = [0.95, 0.62, 0.42, 0.28, 0.2, 0.14]

    /** Width and the fixed top margin of the viewBox; the height follows the labels. */
    const WIDTH = 720
    const PAD = { left: 62, right: 18, top: 14 }
    const PLOT_HEIGHT = 236

    const en = {
      'chart.title': 'Chart',
      'chart.unsupported': 'This chart type is not rendered yet; the table above still carries these values.',
      'chart.legend': 'Series',
      'chart.truncated': 'Some categories are shortened to fit.',
      'chart.aria': 'Chart drawn from the table above',
    }

    const zh = {
      'chart.title': '图表',
      'chart.unsupported': '该图型暂不渲染；这些数值仍以表格为准。',
      'chart.legend': '系列',
      'chart.truncated': '部分类目名称已省略以适应宽度。',
      'chart.aria': '由上方表格生成的图表',
    }

    const CSS = `
.omd-chart {
  margin: 6px 0 2px;
  padding: 8px 12px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  color: var(--dsw-alias-label-primary, inherit);
  overflow: hidden;
}
.omd-chart-title { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
.omd-chart-svg { display: block; width: 100%; height: auto; }
.omd-chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 14px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.omd-chart-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: currentColor;
  margin-right: 5px;
  vertical-align: -1px;
}
.omd-chart-note { margin: 4px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.omd-chart-axis { font-size: 11px; fill: currentColor; }
`

    /** Install this card's stylesheet once; the plugin's fiber owns its lifetime. */
    function installStyles() {
      if (document.querySelector('style[data-plugin-css="omd-table-chart/card"]') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.pluginCss = STYLE_OWNER
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    /** One series, normalized so one malformed entry cannot blank the card. */
    function normalizeSeries(input) {
      if (typeof input !== 'object' || input === null) return null
      if (typeof input.header !== 'string') return null
      if (!Array.isArray(input.values)) return null
      return {
        header: input.header,
        dim: typeof input.dim === 'string' ? input.dim : 'count',
        values: input.values.map(value =>
          (typeof value === 'number' && Number.isFinite(value) ? value : null)),
      }
    }

    /** The stored spec, or null when the record cannot be drawn at all. */
    function normalizeSpec(input) {
      if (typeof input !== 'object' || input === null) return null
      if (typeof input.kind !== 'string') return null
      if (!Array.isArray(input.categories) || !Array.isArray(input.series)) return null
      const categories = input.categories.map(name => String(name))
      const series = input.series.map(normalizeSeries).filter(entry => entry !== null)
      if (categories.length === 0 || series.length === 0) return null
      const whole = normalizeSeries(input.whole)
      return {
        kind: input.kind,
        categories,
        series,
        whole: whole === null ? undefined : whole,
        order: typeof input.order === 'string' ? input.order : null,
        focus: Array.isArray(input.focus)
          ? input.focus.filter(index => typeof index === 'number' && Number.isInteger(index))
          : [],
        polarity: typeof input.polarity === 'object' && input.polarity !== null ? input.polarity : {},
        rivals: typeof input.rivals === 'string' ? input.rivals : undefined,
        title: typeof input.title === 'string' ? input.title : undefined,
      }
    }

    /** The record, normalized; null when the event is not one this card draws. */
    function normalize(data) {
      if (typeof data !== 'object' || data === null) return null
      if (typeof data.anchorSeq !== 'number' || !Number.isFinite(data.anchorSeq)) return null
      const spec = normalizeSpec(data.spec)
      if (spec === null) return null
      return {
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
        anchorSeq: data.anchorSeq,
        turn: typeof data.turn === 'number' ? data.turn : 0,
        step: typeof data.step === 'number' ? data.step : 0,
        spec,
      }
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
      if (typeof data.anchorSeq !== 'number') return null
      return { id: String(data.anchorSeq), role: 'start' }
    }

    /** The newest record for one anchor wins; every record is whole. */
    function start(_context, matched) {
      return normalize(matched.event.data)
    }

    /** A round number for the scale, so ticks land on readable values. */
    function niceStep(raw) {
      if (!Number.isFinite(raw) || raw <= 0) return 1
      const exponent = Math.floor(Math.log10(raw))
      const base = raw / 10 ** exponent
      const step = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10
      return step * 10 ** exponent
    }

    /** A zero-inclusive scale with four intervals. */
    function scaleFor(values) {
      const finite = values.filter(value => typeof value === 'number' && Number.isFinite(value))
      let min = Math.min(0, ...finite)
      let max = Math.max(0, ...finite)
      if (min === max) max = min + 1
      const step = niceStep((max - min) / 4)
      return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step }
    }

    /** A compact number, with no trailing zeros. */
    function decimal(value) {
      const abs = Math.abs(value)
      const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
      return String(Number(value.toFixed(digits)))
    }

    /** One value in the unit its column was written in; the host normalized to base units. */
    function formatValue(value, dim) {
      if (!Number.isFinite(value)) return ''
      if (dim === 'percent') return `${decimal(value)}%`
      if (dim === 'duration') {
        return Math.abs(value) >= 1000 ? `${decimal(value / 1000)} s` : `${decimal(value)} ms`
      }
      if (dim === 'bytes') {
        const units = [['GiB', 1024 ** 3], ['MiB', 1024 ** 2], ['KiB', 1024], ['B', 1]]
        for (const [suffix, size] of units) {
          if (Math.abs(value) >= size) return `${decimal(value / size)} ${suffix}`
        }
        return `${decimal(value)} B`
      }
      if (dim === 'currency') return `$${decimal(value)}`
      return decimal(value)
    }

    /** Shorten a label and mark it; the full text stays in the category list. */
    function clip(label, limit) {
      return label.length <= limit ? label : `${label.slice(0, limit - 1)}…`
    }

    /** The plot rectangle and whether category labels must lean. */
    function layoutOf(spec) {
      const longest = spec.categories.reduce((most, label) => Math.max(most, label.length), 0)
      const rotate = spec.categories.length > 6 || longest > 10
      const bottom = rotate ? 112 : 52
      return {
        rotate,
        height: PAD.top + PLOT_HEIGHT + bottom,
        plot: { x: PAD.left, y: PAD.top, w: WIDTH - PAD.left - PAD.right, h: PLOT_HEIGHT },
      }
    }

    /** Category centres along the x axis. */
    function bandXs(plot, count) {
      const band = plot.w / count
      return Array.from({ length: count }, (_, index) => plot.x + band * (index + 0.5))
    }

    /** A y coordinate for a value. */
    function yOf(value, scale, plot) {
      return plot.y + plot.h - ((value - scale.min) / (scale.max - scale.min)) * plot.h
    }

    /** The three lines a chart frame shares: grid, y ticks, x labels. */
    function frame(spec, layout, scale, dim, t) {
      const { plot } = layout
      const nodes = []
      const ticks = []
      for (let value = scale.min; value <= scale.max + scale.step / 2; value += scale.step) {
        ticks.push(value)
      }
      for (const value of ticks) {
        const y = yOf(value, scale, plot)
        nodes.push(h('line', {
          key: `grid-${value}`,
          x1: plot.x,
          x2: plot.x + plot.w,
          y1: y,
          y2: y,
          stroke: 'currentColor',
          strokeOpacity: value === 0 ? 0.32 : 0.1,
          strokeWidth: 1,
        }))
        nodes.push(h('text', {
          key: `tick-${value}`,
          className: 'omd-chart-axis',
          x: plot.x - 10,
          y: y + 4,
          textAnchor: 'end',
          fillOpacity: 0.68,
        }, formatValue(value, dim)))
      }
      const xs = bandXs(plot, spec.categories.length)
      spec.categories.forEach((label, index) => {
        const x = xs[index]
        const focused = spec.focus.includes(index)
        if (layout.rotate) {
          const y = plot.y + plot.h + 14
          nodes.push(h('text', {
            key: `label-${index}`,
            className: 'omd-chart-axis',
            x,
            y,
            transform: `rotate(-35 ${x} ${y})`,
            textAnchor: 'end',
            fillOpacity: focused ? 1 : 0.78,
            fontWeight: focused ? 600 : 400,
          }, clip(label, 24)))
        } else {
          const limit = Math.max(6, Math.floor((plot.w / spec.categories.length) / 7))
          nodes.push(h('text', {
            key: `label-${index}`,
            className: 'omd-chart-axis',
            x,
            y: plot.y + plot.h + 18,
            textAnchor: 'middle',
            fillOpacity: focused ? 1 : 0.78,
            fontWeight: focused ? 600 : 400,
          }, clip(label, limit)))
        }
      })
      return nodes
    }

    /** A translucent band marking a focused category. */
    function focusBands(spec, plot) {
      const band = plot.w / spec.categories.length
      return spec.focus
        .filter(index => index >= 0 && index < spec.categories.length)
        .map(index => h('rect', {
          key: `focus-${index}`,
          x: plot.x + band * index,
          y: plot.y,
          width: band,
          height: plot.h,
          fill: 'currentColor',
          fillOpacity: 0.05,
        }))
    }

    /** Bar and grouped: one upright bar per value, side by side within a category. */
    function bars(spec, plot, scale) {
      const band = plot.w / spec.categories.length
      const grouped = spec.kind === 'grouped'
      const groupWidth = band * (grouped ? 0.82 : 0.58)
      const barWidth = groupWidth / spec.series.length
      const nodes = []
      spec.series.forEach((series, seriesIndex) => {
        series.values.forEach((value, index) => {
          if (value === null || value === 0) return
          const base = plot.x + band * index + (band - groupWidth) / 2
          const top = yOf(Math.max(0, value), scale, plot)
          const bottom = yOf(Math.min(0, value), scale, plot)
          nodes.push(h('rect', {
            key: `bar-${seriesIndex}-${index}`,
            x: base + barWidth * seriesIndex + (grouped ? 0 : (barWidth * (spec.series.length - 1)) / 2),
            y: top,
            width: Math.max(1, barWidth - (grouped ? 1 : 0)),
            height: Math.max(1, bottom - top),
            fill: 'currentColor',
            fillOpacity: SERIES_OPACITY[seriesIndex % SERIES_OPACITY.length],
            rx: 1.5,
          }))
        })
      })
      return nodes
    }

    /** Stacked: each category's parts pile from the zero line, up and down. */
    function stackedBars(spec, plot, scale) {
      const band = plot.w / spec.categories.length
      const width = band * 0.62
      const nodes = []
      const up = spec.categories.map(() => 0)
      const down = spec.categories.map(() => 0)
      spec.series.forEach((series, seriesIndex) => {
        series.values.forEach((value, index) => {
          if (value === null || value === 0) return
          const from = value > 0 ? up[index] : down[index]
          const to = from + value
          if (value > 0) up[index] = to
          else down[index] = to
          const top = yOf(Math.max(from, to), scale, plot)
          const bottom = yOf(Math.min(from, to), scale, plot)
          nodes.push(h('rect', {
            key: `stack-${seriesIndex}-${index}`,
            x: plot.x + band * index + (band - width) / 2,
            y: top,
            width,
            height: Math.max(1, bottom - top),
            fill: 'currentColor',
            fillOpacity: SERIES_OPACITY[seriesIndex % SERIES_OPACITY.length],
          }))
        })
      })
      return nodes
    }

    /** Line: one path per series, broken where a category has no value. */
    function lines(spec, plot, scale) {
      const xs = bandXs(plot, spec.categories.length)
      const nodes = []
      spec.series.forEach((series, seriesIndex) => {
        const opacity = SERIES_OPACITY[seriesIndex % SERIES_OPACITY.length]
        let path = ''
        let drawing = false
        series.values.forEach((value, index) => {
          if (value === null) {
            drawing = false
            return
          }
          const command = drawing ? 'L' : 'M'
          path += `${command}${xs[index].toFixed(1)} ${yOf(value, scale, plot).toFixed(1)} `
          drawing = true
        })
        if (path !== '') {
          nodes.push(h('path', {
            key: `line-${seriesIndex}`,
            d: path.trim(),
            fill: 'none',
            stroke: 'currentColor',
            strokeOpacity: opacity,
            strokeWidth: 2,
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
          }))
        }
        series.values.forEach((value, index) => {
          if (value === null) return
          const focused = spec.focus.includes(index)
          nodes.push(h('circle', {
            key: `dot-${seriesIndex}-${index}`,
            cx: xs[index],
            cy: yOf(value, scale, plot),
            r: focused ? 3.6 : 2.4,
            fill: 'currentColor',
            fillOpacity: opacity,
            ...focused ? { stroke: 'currentColor', strokeOpacity: 0.5, strokeWidth: 1.4 } : {},
          }))
        })
      })
      return nodes
    }

    /** The legend: a swatch per series, in the same opacity order as the marks. */
    function legend(spec) {
      if (spec.series.length < 2) return null
      return h('div', { className: 'omd-chart-legend' },
        spec.series.map((series, index) => h('span', { key: `legend-${index}` },
          h('span', {
            className: 'omd-chart-swatch',
            style: { opacity: SERIES_OPACITY[index % SERIES_OPACITY.length] },
          }),
          series.header)))
    }

    /** One chart's SVG, or the explicit notice for a kind this renderer does not draw. */
    function ChartFigure({ spec, t }) {
      const title = spec.title ?? spec.series.map(series => series.header).join(' · ')
      if (!SUPPORTED.has(spec.kind)) {
        return h('figure', { className: 'omd-chart' },
          h('figcaption', { className: 'omd-chart-title' }, title || t('chart.title')),
          h('p', { className: 'omd-chart-note' }, `${spec.kind}: ${t('chart.unsupported')}`))
      }
      const layout = layoutOf(spec)
      const dim = spec.series[0].dim
      let scaleValues = spec.series.flatMap(series => series.values.filter(value => value !== null))
      if (spec.kind === 'stacked') {
        scaleValues = spec.categories.map((_, index) => {
          let up = 0
          let down = 0
          for (const series of spec.series) {
            const value = series.values[index]
            if (value === null) continue
            if (value > 0) up += value
            else down += value
          }
          return up + down
        }).concat(scaleValues)
      }
      const scale = scaleFor(scaleValues)
      const marks = spec.kind === 'line'
        ? lines(spec, layout.plot, scale)
        : spec.kind === 'stacked'
          ? stackedBars(spec, layout.plot, scale)
          : bars(spec, layout.plot, scale)
      const svg = h('svg', {
        className: 'omd-chart-svg',
        width: WIDTH,
        height: layout.height,
        viewBox: `0 0 ${WIDTH} ${layout.height}`,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        'aria-label': spec.title ?? t('chart.aria'),
      },
        focusBands(spec, layout.plot),
        frame(spec, layout, scale, dim, t),
        ...marks)
      return h('figure', { className: 'omd-chart' },
        h('figcaption', { className: 'omd-chart-title' }, title || t('chart.title')),
        svg,
        legend(spec))
    }

    /** The chat row: one record, drawn. */
    function ChartCard({ node, t }) {
      const record = node.data
      if (record === null || typeof record !== 'object') return null
      return h(ChartFigure, { spec: record.spec, t })
    }

    /**
     * Install the Definition, the card seat, and the stylesheet.
     * @param ctx - client plugin context carrying the Conversation and Slot registries.
     */
    function apply(ctx) {
      ctx.effect(installStyles)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'omd-table-chart: dictionaries')

      ctx.uiConversation.events.register({
        kind: 'omdChartSpec',
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
            anchorSeq: record.anchorSeq,
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
      }, ChartCard))
    }

    exports.inject = ['slots', 'locale', 'uiConversation']
    exports.apply = apply
    return module.exports
  },
})
