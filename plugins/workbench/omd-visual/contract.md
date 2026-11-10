# Visualization fence contract (for the visual subagent)

Output exactly ONE fenced block. You have no UI tools; never call or name one.

## Fence

```dsh-ui
{ "title": "...", "items": [ ... ] }
```

- Body is the document JSON itself, max 128 KiB, no trailing prose.
- Alternative: a ```svg fence with one self-contained `<svg>…</svg>`; no scripts, no external refs.
- If a visualization adds no structure, reply exactly: `NO_VISUAL`

## Document forms (choose one)

1. Extended: `{"title":"...","items":[components]}`
2. Native v1: `{"version":1,"title":"...","fallback":"...","nodes":[nodes],"state":{},"derived":{},"presentation":{}}`

## Extended components (fields exact)

- text `{type,content,size?:"h1"|"h2"|"h3"|"body"|"muted"}`
- row/col/grid/card `{type,items:[...],title?,cols?,gap?}`
- stat `{type,label,value}`; callout `{type,title?,content,tone:"info"|"success"|"warning"|"error"}`
- list `{type,items:[string]}`; keyvalue `{type,pairs:[{key,value}]}`
- timeline `{type,items:[{title,desc?,time?}]}`; file-tree `{type,items:[{name,type:"file"|"dir",children?}]}`
- table `{type,columns:[string],rows:[[scalar]],types?}`
- chart `{type,kind:"bars"|"line"|"donut",data:[{label,value}]}`
- mermaid `{type,code}` for automatic graph layout
- diagram `{type,kind:"architecture",nodes:[{id,label,type:"focal"|"backend"|"store"|"external",x,y,w,h}],edges:[{from,to,label?}]}`
- svg `{type,title,code}` with one complete inline SVG; code `{type,lang,code,title?,wrap?}`

## Native v1 nodes (inside "nodes")

heading / text / card / metric / table / chart / steps / slider / input / select / toggle / visual.
Controls bind `"state.key"`; declare bounds in state, never on controls.
Derived: `{"total":{"expr":"state.quantity * 12"}}`; only `+ - * /`, comparisons, ternary and min/max/round/ceil/floor/abs.

## Size, theme, layout

- Whole document ≤ 128 KiB; prefer ≤ 40 nodes; tables scroll horizontally.
- presentation.layout: dashboard | workbench | comparison | guide | status | report.
- presentation.accent: blue | teal | violet | amber | rose; density: comfortable | compact.
- Colors follow the host theme; never set a page background. SVG must fit its viewBox.

## Content rules

- Visualize only facts present in the answer; never invent numbers, sources, measurements or progress.
- `fallback` must read as a complete text summary (the reader may see only it).
- No external images/fonts/network; no HTML in native text; no secrets.
