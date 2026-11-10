# omd-agents-live

Live subagent and background-job state for the web ticker, served as one
internal path: `dsh-resource://agents/<sessionId>`.

Host half only. No session event, no prompt section, no tool: this is a view
of a session that already exists. The durable roster stays
`omd-agents-hub`'s `omdAgents` projection; this package adds "now".

## Address and response

```
dsh-resource://agents/<sessionId>
```

`<sessionId>` must be a live session in this process (open it first). The read
returns one JSON document, pretty-printed:

```json
{
  "sessionId": "…",
  "generatedAt": 1750000000000,
  "agents": [
    {
      "id": "351822cc-…",
      "name": "VisualImpl",
      "status": "running",
      "startedAt": 1749999990000,
      "elapsedMs": 12345,
      "activity": { "kind": "tool", "label": "read plugins/host/omd-todo/src/index.ts" },
      "model": "magpie/group/engineer",
      "tokens": 12345,
      "toolCalls": 7,
      "metrics": [
        { "label": "mpsnr", "value": 40.2, "unit": "dB", "delta": -5.7 }
      ],
      "headline": { "label": "40.2 dB", "delta": -5.7, "note": "best @ iter 10.0k" }
    }
  ],
  "jobs": [
    {
      "id": "bash-f5c8c55384ec4258",
      "kind": "bash",
      "label": "sleep 60",
      "status": "running",
      "startedAt": 1749999990000,
      "elapsedMs": 12345,
      "metrics": null,
      "headline": null
    }
  ]
}
```

Agents and jobs are sorted live-first, then by `startedAt` ascending.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `activityMaxChars` | `80` | Longest `activity.label`, in UTF-16 code units — the unit of `String.prototype.length`, so an astral character (an emoji) counts as two. A clipped label ends in `…`, which occupies one of the characters. Must be at least 1. |
| `settledJobGraceMs` | `8000` | How long a settled background job stays visible once no turn is open; see Job retention. |
| `settledAgentGraceMs` | `30000` | How long a child with a terminal status stays visible; see Agent retention. |

`activityMaxChars` changes only how a label is clipped: the tracked facts,
their retention, and the wire shape are unaffected.

## Where each field comes from

| Field | Source |
|---|---|
| discovery (`id`, name, creation time) | the parent's own `subagent/catalog` rows; a name falls back to the child's `subagent/descriptor` label, then the first 8 id characters |
| `status` | `ctx.agents.get(id).status` (`running`/`idle`) first; otherwise the `omdAgents` row word. A durable `active` row with no live agent reads `settled` — the process cannot prove it is running. Anything but `running` is retained only for `settledAgentGraceMs` |
| `startedAt` | the catalog row's `childCreatedAt`; fallback: the child's first own event time |
| `elapsedMs` | `now - startedAt` while `running`; frozen at the child's last own event once ended; `null` when no live child log was seen |
| `activity` | the newest own `tool/call` or `assistant/message`. A tool call renders `name` plus its most telling argument (`command`, `path`, `pattern`, `query`, …); a message renders its first sentence (clipped to `activityMaxChars`, default 80). Reasoning without visible text renders `thinking` |
| `model` | `provider/model` of the child's newest assistant message |
| `tokens` | sum of `usage` on the child's own assistant messages |
| `toolCalls` | count of the child's own `tool/call` events; `null` when the child was never live |
| jobs | `ctx.jobs.list(sessionId)`, filtered to this session's owner |

Fork semantics: only events outside the child's inherited prefix are folded,
so a fork child that said nothing never shows the parent's activity, tokens, or
metrics.

## Job retention

`ctx.jobs.list` keeps settled records until the owning session is disposed.
The ticker should not. A settled job stays visible while the turn it finished
in is open; once no turn is open, it stays for `settledJobGraceMs` (default
8000) and then disappears. While a turn is open, a job that finished before
that turn started is hidden immediately.

## Agent retention

`omdAgents` is a durable roster and keeps every child forever; the ticker must
not. The band answers "what is happening now", so a child row keeps **no
history at all**: once its status is anything but `running`, it stays for
`settledAgentGraceMs` (default 30000) and then leaves the document. There is
deliberately no list of finished children behind it — one row per child ever
delegated would grow without bound and push the live rows out of a
fixed-height band, and the durable roster already answers "what did my workers
end as" for anyone who asks it directly.

The window is counted from the child's own last event, not from the read that
first noticed the end, so a poll arriving late drops an already-finished child
at once instead of granting it a fresh window. A child with no live log — an
external provider, a session disposed before it was first read, or a session
read after a process restart — carries no such instant; its window starts at
the first read that proves it settled, so it is listed at most once and leaves
one window later.

`elapsedMs` freezes at the child's last own event when the child stops, so the
value a reader sees during the window is the final one rather than a clock
running against a dead log.

The catalog row itself stays in the tracker's memory, so a child woken again by
a follow-up message returns as a `running` row without waiting for another
`subagent/catalog` event, and `running` always outranks the grace clock.

A row orphaned by a parent fork or restart follows the same rule, and it can
never read `running`: a disposed agent is unregistered from `ctx.agents` before
its session leaves the store, and a child with no live session has no live
facts. `0` for `settledAgentGraceMs` drops a child the moment it settles.

## Metric extraction (heuristic, no model call)

`extractMetrics(text)` is a pure function in `src/metrics.ts`. It is not a
general log parser.

- **Window.** Only the last 40 lines of one text are scanned: a child's newest
  tool result or assistant text, or a job's retained output tail (the tail is
  read incrementally through `jobs.readAt`, capped at 16 KiB).
- **Metric shape.** `name value [unit]`, where `name` matches
  `[A-Za-z_][\w./-]{1,19}`, `value` may carry a sign and a decimal part, and
  `unit` is an immediately following short token (`dB`, `ms`, `%`, `k`, `GB/s`).
  Several metrics may share a line, separated by `·`, `,`, `|`, or spaces.
  Ordinary words (`of`, `at`, `iter`, `step`, …) are rejected as names.
- **Change.** A trailing `▲x%`, `▼x%`, `±x%`, `+x%`, or `-x%` becomes a signed
  `delta`. `▲` and `+` are positive; `▼`, `-`, and `±` are negative.
- **Candidate gate.** A `name value [unit]` pair is a candidate when any of
  these holds:
  1. its value is a decimal (`loss 0.1234`, `ssim 0.9445`);
  2. its value is a whole number and it carries a unit (`p95 1200 ms`);
  3. its value is a whole number and it carries a change (`epoch 12 +3%`).
- **Line gate.** A line's candidates are reported when any of these holds:
  1. the line carries two or more candidates
     (`val acc 0.87 · val loss 0.31`, `mpsnr 40.20 dB ▼5.7% · ssim 0.9445 ▼1.0%`);
  2. the line contains one of `metric`, `metrics`, `loss`, `acc`, `score`,
     `best`, `val`, `test`, `eval` (`loss 0.1234`);
  3. the line carries exactly one candidate and that candidate has a unit or a
     change (`p95 1200 ms`).
  Otherwise the line is dropped, so `2` from a `grep -c` result, `step 3 done`,
  and `wrote 12 files` yield nothing.
- **Headline.** The first metric that carries a `delta`. A nearby
  `best @ iter 10.0k` / `@ iter 10.0k` phrase, else `best <name> <value> <unit>`,
  becomes its `note`.
- **Limits.** At most 6 metrics; the first occurrence of a repeated name wins.
- **No fabrication.** Nothing passing the gate means `metrics: null` and
  `headline: null`.

## Following

The source declares `live: true`. `omd-internal-paths` owns the follow interval
(`livePollMs`, default 1500 ms) and polls `read`; this package cannot set a
per-source interval. Each read advances per-child folds, parent catalog
watermarks, and job output tails, so a poll costs only the events that arrived
since the previous one.

## Known limitations

- Children without a local session (external providers) have no live facts:
  the row shows the durable status and `null` for everything the process cannot
  read.
- After a parent restart, an ended child is listed once with `elapsedMs: null`
  and no metrics — its session log is no longer live — and leaves after
  `settledAgentGraceMs`.
- `name` falls back to the first 8 id characters when both the catalog and the
  child's descriptor carry no label.

## Model Experience

None. The source is not model-visible; it registers no tool and appends no
session event, so it cannot affect request context or KV cache.
