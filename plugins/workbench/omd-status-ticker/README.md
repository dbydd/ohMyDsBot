# omd-status-ticker

A two-line news ticker pinned to the top of the dsh web frame: child agents on
the first line, background jobs on the second. Each item is one segment —
headline, name, status, elapsed time, one-line activity summary, and for jobs and
agents alike whatever metrics the source extracted.

The band holds no state of its own beyond a one-second clock. Everything it shows
comes from one address, `dsh-resource://agents/<sessionId>`, served by the host
half `omd-agents-live`; this package is the browser half only.

## Where it renders, and why there

The band registers into `shell.overlay`. That choice is forced by two facts:

1. **Every seat at the top of the frame is a single occupant, and every one of
   them is taken.** Registering into any of them replaces its current occupant
   rather than adding to it, which is exactly the "do not take someone else's
   render right" line.

   | seat | kind | who holds it | contract line |
   |---|---|---|---|
   | `conversation.header` | `single` | `ui-conversation`'s conversation root | `packages/client/ui-conversation/src/client/apply.ts:331-334` |
   | `conversation.session.header` | `single` | the Session header (title, actions, view tabs) | `.../apply.ts:428-437` |
   | `conversation.session.header.corner` | `single` | `ui-sidebar-right`'s expand button | `packages/client/ui-sidebar-right/src/client/index.ts:238-245` |
   | `conversation.session.header.utilities` | `list` | right-aligned utilities, inside a 30px title row | `.../apply.ts:434` |
   | `shell.leading` | `single` | macOS window-chrome controls, and only while the sidebar is fully collapsed | `packages/client/ui-layout/src/client/index.ts:106-119` |
   | `shell.bottom` | `single` | in flow, full width — but a *bottom* row | `.../index.ts:88-94` |

2. **`shell.overlay` is the frame's documented seat for a surface of one's own.**
   Its declaration reads: "Frame-wide floating layer, above every column and
   outside their scroll containers. Deliberately generic and unowned by any
   feature … This is the additive seat for a frame-wide surface of your own: a
   fresh `id` is added beside the shipped entries instead of replacing them"
   (`packages/client/ui-layout/src/client/index.ts:95-105`). It is a `list`, so
   `order: -100` puts this band first among the shipped toasts and dialogs
   without removing any of them, and the layer is click-through by default
   (`.overlayLayer { pointer-events: none }`, `AppFrame.module.css:281-286`), so
   only the band's own box takes the pointer.

### Why it reserves height instead of floating over the header

`shell.overlay` takes no height: its layer is `position: absolute; inset: 0`
(`AppFrame.module.css:281-290`). A band painted at `top: 0` would therefore sit
on top of the frame's top strip, which is fully occupied:

- the conversation header starts at the top of the centre column and is 76px
  tall (10px inset + 30px title row + tab strip), `ConversationRoot.module.css:10-23`;
- the sidebar's window strip is 52px tall with its toggle centred at y 25, and
  the macOS traffic lights sit at (16, 18), `SidebarRoot.module.css:176-193`;
- the frame publishes the same band as `--dsh-frame-top-clearance: 48px`,
  `AppFrame.module.css:88-90`.

So the band takes its own space instead of covering theirs. While it has at
least one live row, it sets `html[data-omd-status-ticker]` and the stylesheet
pads the mount point:

```css
html[data-omd-status-ticker] #root {
  box-sizing: border-box;
  padding-top: var(--omd-ticker-height);
}
```

`--omd-ticker-height` is written inline from the row count (one line is 21px,
two lines 39px: 16px per row, 2px gap, 4px padding, 1px rule). The frame and
everything inside it start below the band, so no upstream surface is covered and
nothing loses its render right — the frame only gets 21–39px shorter. With no
live row the component renders `null`, the attribute disappears, and the frame
keeps its full height.

`#root` is the one stable anchor: the frame itself is a CSS-module class, but
`html, body, #root { height: 100% }` is the published base rule
(`packages/client/web/src/base.css:4-9`), and `box-sizing: border-box` keeps the
padding from growing the page.

## Data

Address: `dsh-resource://agents/<sessionId>`, read through the `useResource`
global standard hook. The session is the one the main view is showing
(`retainedBy.mainView`), because the band is frame chrome, not a per-panel
widget.

```json
{
  "agents": [{ "id", "name", "status", "startedAt", "elapsedMs",
               "activity": { "kind", "label" }, "metrics": [{ "label", "value", "unit", "delta" }],
               "headline": { "label", "delta", "note" } }],
  "jobs":   [{ "id", "kind", "label", "status", "startedAt", "elapsedMs", "metrics", "headline" }]
}
```

The value may arrive as a JSON string (the internal-path read returns text) or
as an object; both are accepted, and a malformed payload renders nothing. The
source declares `live: true`, so the address is followed by
`omd-internal-paths`' browser half and yields a frame only when the content
changed.

## Rendering rules

- **Only live rows.** A status in `completed, done, failed, error, timeout,
  cancelled, killed, stopped, exited` is dropped; an unknown status counts as
  live. A row without a start sorts as the oldest of its rank.
- **Order.** `running` first, then ascending `startedAt`; ties keep the source's
  order.
- **Elapsed time.** `elapsedMs` is the baseline, and a local one-second interval
  adds the drift since the frame arrived, so the clock does not follow the poll
  period. `startedAt` is the fallback when the frame carries no `elapsedMs`.
- **Headline first.** An agent's `headline` (`label`, `delta`, `note`) is the
  first thing in its segment, before the name.
- **Metrics.** `mpsnr 40.20 dB ▼5.7%`: integer values print bare, others to two
  decimals; `delta` prints to one decimal with `▲` above zero and `▼` below, and
  no arrow at zero or when absent.
- **Separators.** Segments are separated by 22px of space; within a segment the
  parts are joined by ` · `.

## Degradation

- **No data** — no live agent and no live job, a session not yet known, or a
  provider that is not registered (`status: 'none'`): the component returns
  `null`, no element, no attribute, no height.
- **`prefers-reduced-motion: reduce`** — the marquee is not started at all
  (matchMedia is read live, so toggling the OS setting stops or starts it), the
  second copy is not rendered, and the content is a single static line that ends
  in an ellipsis when it does not fit. The stylesheet repeats the same rules
  under the media query as a belt.
- **Content that fits** — no animation either; the line is simply shown. A copy
  scrolls only when its measured content is wider than its window.
- **Hover** — the marquee pauses while the pointer or focus is over the line.

Colour uses `currentColor` and CSS custom properties only. The band defines the
names it needs (`--fg`, `--muted`, `--border`, `--surface`, `--accent`,
`--success`, `--warning`, `--error`) on its own root, each mapped to the
`--dsw-alias-*` token of the same meaning with `currentColor` as the fallback, so
light and dark themes both read the text.

## Mounting

```yaml
- insert:
    - id: omd-status-ticker
      name: omd-status-ticker
```

The host row (`src/index.ts`) is an empty `apply()`: the browser half owns every
contribution, and the row exists only so the client module table can attach that
half to a live Loader entry (`docs/subsystems/client-modules.md`). No session
event is written and no config is read.

## Known limitations

- With no `agents` provider registered, the band never appears. That is the
  designed degradation, not a fallback to another source.
- macOS draws the traffic lights over the page; the band insets its text by 84px
  on darwin so nothing lands under them. On Windows the caption buttons overlay
  the band's right end, so the text insets by 148px there.
- The band follows one session — the one the main view shows. Other sessions'
  agents and jobs are not aggregated.
