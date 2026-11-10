# omd-table-chart

One package, two halves. The host half reads the table in a settled answer and
appends one `plugin:omd/table-chart` record; the client half folds that record
into the chat row and draws it as an inline SVG.

```
turn ends ──► final assistant message of the turn
            ──► analyzeTable → planChart → buildSpec      (omd-chart-plan)
            ──► no plan: nothing written
            ──► plugin:omd/table-chart record on the session, anchored at the message seq
            ──► client: omdChartSpec folds it → omdChartCard draws the SVG
```

No model call, no tool, no fork. The heuristic is the only decider in this
slice; every record says `decidedBy: { role: 'heuristic' }`. The judge path is
a separate slice and overwrites plan fields, not this record's shape.

## Why the record, not DOM work

The record carries the whole `ChartSpec` — categories, series values, order,
focus, polarity, title — so drawing needs nothing from the host process. A page
refresh, a fork, or a resume folds the same record out of the session log and
draws the same picture; the chart is history, not a transient widget. The record
is `ignorable` plugin data: it never enters the model surface and the next
request is unchanged by a chart having been drawn.

The host also accepts `dsh-resource://chart/<sessionId>/<anchorSeq>` through
`ctx.internalPaths`, returning the kind, categories, series and plan as text. It
is a read surface only; an agent can check what was drawn without the browser.

## Record: `plugin:omd/table-chart`

```jsonc
{
  "sessionId": "session-…",
  "anchorSeq": 23,          // assistant message the chart hangs under
  "turn": 1,
  "step": 2,
  "component": "table-chart",
  "spec": { "kind": "stacked", "categories": [...], "series": [...], "whole": {...},
            "order": null, "focus": [], "polarity": {...}, "rivals": "columns" },
  "plan": { "kind": "stacked", "label": 0, "series": [2, 3], "whole": 1, ... },
  "decidedBy": { "role": "heuristic" },
  "createdAt": 1761130000000
}
```

One record per assistant message. The trigger skips a message that already has
one, so a turn that stops and continues does not stack charts on the same anchor.
`plan` keeps the column indices the heuristic chose; `spec` is what the renderer
draws. The resource source prints both.

## Client kinds

| kind | rendering |
|---|---|
| `bar`, `line`, `stacked`, `grouped` | inline SVG, viewBox-scaled to the container |
| `paired`, `progress`, `heatmap`, `multiples` | series names as the title (or the spec's own title) plus one sentence naming the kind and saying it is not drawn yet |

The unsupported branch is explicit on purpose: it is a card with text, not an
error and not a blank row. The table itself is still in the message above it.

The SVG uses `currentColor` and opacity steps only — no literal fill, no
background colour — so the same drawing reads in light and dark themes. Width is
the container's; category labels lean at 35° when there are more than six or any
label is longer than ten characters, and long labels are clipped with `…`.
Values are formatted from the column dimension: milliseconds become seconds past
1000, bytes become KiB/MiB/GiB, percent points get `%`.

## Config

| field | default | meaning |
|---|---|---|
| `mode` | `heuristic` | `off` writes no records; records already in the log still render |
| `minRows` | `2` | fewest data rows, summary rows excluded, a table needs to be charted |

Mount with one patch row; the package is not a bundle:

```yaml
- insert:
    - id: omd-table-chart
      name: omd-table-chart
```

`omd-chart-plan` is imported by package name. The profile links only this
package, so its bare import resolves from the importer's real path — which is
why `omd-chart-plan` is in `SIBLING_PACKAGES` in
`plugins/link-host-runtime.mjs`, keeping a symlink in `plugins/node_modules`.

## Model Experience

None. The plugin registers no tool, no command, and no prompt section, and the
record is `ignorable`, so no request prefix or tool array changes. The only
model-adjacent surface is `dsh-resource://chart/...`, read on demand through the
internal-path registry.

## Known Limitations and Deferred Work

- Only the first Markdown table of the final assistant message is read. A second
  table in the same answer is ignored.
- The judge path is not wired: `decidedBy` is always `heuristic`, and `title`
  stays absent unless the heuristic finds one.
- Four kinds render. `paired`, `progress`, `heatmap`, and `multiples` take the
  notice branch until their renderers exist.
- No table-highlight coupling: a chart does not link back to the table cells it
  came from.
- The resource source addresses live sessions only. Reading a chart from a cold
  session log is not implemented; the web client folds the log instead.
