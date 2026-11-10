---
kind: library
---

# omd-internal-http

The internal-path registry as HTTP, so a shell script reaches the same
addresses the model does. Two verbs, one address syntax: GET fetches a
representation, POST submits to the address; GET on the stream route follows an
address whose source pushes changes.

The plugin is a transport adapter and nothing else. `InternalPathsService`
already owns the vocabulary — `fetch` (the source's own representation, or its
document read), `submit` (the source's own action, or its document write) — so
this package adds no address grammar, no per-source knowledge and no second
registry.

| route | method | what happens |
|---|---|---|
| `/api/paths` | GET | the roster: `{"sources": [...]}` from `internalPaths.sources(exec)` |
| `/api/paths?uri=<address>` | GET | `internalPaths.fetch(address, exec)` |
| `/api/paths?uri=<address>` | POST | `internalPaths.submit(address, <raw body>, exec)` |
| `/api/paths/<source>` | GET, POST | the same two operations, on an endpoint named after one source |
| `/api/paths/stream?uri=<address>` | GET | `internalPaths.stream(address, exec)` as server-sent events |

Connection matches routes by exact pathname, so a source needs a route of its
own. The per-source routes are registered when the fiber loads, reconciled on a
1 s timer while the registry can still gain or lose a source, and released when
the fiber unloads. A route outliving its source by up to one tick is harmless:
the address decides, not the route name.

## The stream

`GET /api/paths/stream?uri=<address>` answers `text/event-stream` and forwards
every line the source pushes as one `data: <line>` frame. Two named events
bracket it:

```
event: open
data: mcp://files/changes

data: {"path":"a.txt","change":"created"}

data: {"path":"b.txt","change":"deleted"}

event: close
data: end
```

`open` means the registry accepted the subscription, so a shell can tell a
quiet stream from a failed one. `close` carries the reason: `end` when the
source finished of its own accord, or the source's message when it threw
mid-stream. The caller's identity is the same as on a buffered route, and
`request.signal` is `exec.signal`, so a client disconnect ends the iteration
even when a source ignores the signal — the transport stops waiting on it.

A source that declares no `watch` is not polled behind its back: the answer is
409 and the body repeats the registry's own wording.

## The address

`uri` carries an internal address exactly as the model writes it: the canonical
`dsh-resource://<source>/<path>`, or the `<source>://<path>` shorthand for a
source that declares `shorthand`. Nothing is rewritten, so a source's own
grammar (`tavern://<project>/<file>`, `onlyne://threads/<alias>/messages`,
`mcp://<server>/<tool>`) is the whole URL convention there is.

The body comes back unchanged. `content-type` is `application/json` when the
body parses as JSON, `text/plain; charset=utf-8` otherwise, and
`application/octet-stream` when the source returns bytes.

## The caller

| input | becomes |
|---|---|
| `?session=<id>` or the `x-dsh-session` header | `exec.sessionId` |
| `?cwd=<path>` | `exec.cwd` |
| — | `exec.origin = 'script'` |
| `request.signal` | `exec.signal` |

`origin: 'script'` is the third identity beside `model` and `human`, so a
source that records who asked can tell a shell apart from the model and from
the browser.

## Errors

| status | cause |
|---|---|
| 400 | `uri` absent, or absent on a per-source route |
| 403 | the registry's own permission check refused the address (`checkPermission`) |
| 404 | the address names no registered source; the body repeats the roster |
| 409 | the source cannot push (`internalPaths.stream` refused: no `watch`) |
| 502 | the source itself failed; the body carries its message |

A failure never arrives as a 200. The mapping is decided from the registry's
own API (`resolve`, `checkPermission`, `sources`) rather than by matching error
text, so a source that rewords its messages changes nothing here.

## Examples

```sh
# every registered source, with grammar, description and capabilities
curl -sS 'http://127.0.0.1:3099/api/paths'

# a document
curl -sS 'http://127.0.0.1:3099/api/paths?uri=tavern://demo/lore'

# an action: the body is the request
curl -sS -X POST --data-binary '{"text":"hello"}' \
  'http://127.0.0.1:3099/api/paths?uri=onlyne://inbox'

# a subscription: one frame per pushed line, until the source ends
curl -sS -N 'http://127.0.0.1:3099/api/paths/stream?uri=mcp://files/changes'
```

The `/api` channel accepts only the browser cookie or an API credential, so a
script must first exchange the launch token `dsh web` printed:

```sh
curl -sS -c jar -o /dev/null \
  'http://127.0.0.1:3099/connect?token=<launch-token>&interactions=none'
curl -sS -b jar 'http://127.0.0.1:3099/api/paths?uri=tavern://demo/lore'
```

`scripts/path` does that exchange and the encoding for you:

```sh
DSH_TOKEN=<launch-token> scripts/path list
DSH_TOKEN=<launch-token> scripts/path get 'tavern://demo/lore'
DSH_TOKEN=<launch-token> scripts/path post onlyne://inbox message.json
DSH_TOKEN=<launch-token> scripts/path watch 'mcp://files/changes'
```

`DSH_URL` defaults to `http://127.0.0.1:3099`. The wrapper writes the body to
stdout and exits non-zero on any answer outside 2xx.

## Known limits

- **One identity per request.** A request carries one session id; a script
  acting for several sessions issues several requests.
- **Per-source routes lag the registry by one tick.** `RESYNC_MS` (1 s) is
  exported, not configured.
- **The stream is one-directional.** A subscription reports that something
  changed; reading the new state is still a separate GET.
