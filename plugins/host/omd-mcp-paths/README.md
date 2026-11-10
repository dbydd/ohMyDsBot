---
kind: library
---

# omd-mcp-paths

MCP servers as internal paths instead of model-visible tools.

## What it mounts

One `mcp` source in the internal-path registry, shared by every server this
profile configures, with `shorthand: true` so `mcp://…` is the canonical written
form and `dsh-resource://mcp/…` resolves to the same place. The plugin never
calls `ctx.tools.register`, so no `mcp__<server>__<tool>` name reaches the model
surface.

Three verbs, three jobs. A read never returns payload and a get never returns a
listing. A fourth, `watch`, pushes changes instead of answering a call.

| verb | address | returns |
|---|---|---|
| read | `mcp://` | configured servers: name, transport, state, listing counts, last error |
| read | `mcp://bus` | supervisor state: per-server era, retry count, next attempt, last refresh, recent events |
| read | `mcp://<server>` | that server's transport, state, era, counts, sampling route, subscriptions, child addresses |
| read | `mcp://<server>/tools` | tool names with their first description line |
| read | `mcp://<server>/tools/<tool>` | the tool's full description, `inputSchema` and `outputSchema` |
| read | `mcp://<server>/resources` | resource `uri`, `name`, first description line, `mimeType` |
| read | `mcp://<server>/prompts` | prompt `name`, description, and its arguments |
| read | `mcp://<server>/prompts/<name>` | that prompt's argument documentation |
| read | `mcp://<server>/templates` | template `name`, `uriTemplate`, first description line, `mimeType` |
| read | `mcp://<server>/templates/<name>` | that template's full documentation and its variable names |
| read | `mcp://<server>/subscriptions` | protocol era, honored filters, live resource subscriptions, counts |
| read | `mcp://<server>/sampling` | the sampling route and the last kept exchanges |
| get | `mcp://<server>/resources/<uri>` | the resource's representation |
| post | `mcp://<server>/tools/<tool>` | the tool's result |
| post | `mcp://<server>/prompts/<name>` | the rendered prompt messages |
| post | `mcp://<server>/templates/<name>` | the representation of the resource the expansion names |
| post | `mcp://<server>/subscriptions` | the resulting subscription state |
| watch | `mcp://<server>/events` | one JSON line per new bus event |
| watch | `mcp://<server>/tools`, `/resources`, `/prompts` | one JSON line when that list changes |

**Resources.** Everything after `/resources/` is the uri, verbatim: slashes,
scheme and query survive, so `mcp://docs/resources/mem://notes/a.md` reads the
resource whose uri is `mem://notes/a.md`. A single text part comes back as that
text. Anything else comes back as JSON: `{server, uri, mimeType?, text?|blob?}`
for one part, or `{server, uri, contents: […]}` when the server returned several.

**Tools.** A post body is the JSON object of arguments; an empty body means no
arguments. The answer is `{server, tool, content, structuredContent?, isError?}`,
the server's own result, with `isError` kept when the server marked the call as
failed. A malformed body is rejected before the call goes out.

**Prompts.** A post body is the JSON object of prompt arguments, which MCP
defines as strings; a non-string value is rejected. The answer is
`{server, name, description?, messages}`, the rendered messages as the server
returned them.

**Templates.** A resource a server offers only through a uri template is
reachable without knowing its uri. The post body supplies the template's
variables; the template's own names are the contract, so a body key the
template does not declare, or a declared name the body leaves out, is refused
with an error naming what was wrong rather than expanded into a different
resource. Expansion is RFC 6570 through the SDK's `UriTemplate`, and the answer
is the resource's representation in the same envelope the resource get returns —
never the template text. The template listing is fetched on first use and
dropped by every listing refresh, so a server that offers none costs one error
on that address and nothing on connect.

## Sampling

A server that asks `sampling/createMessage` gets an answer from the host model.
The route comes from configuration: `provider` and `model` together advertise
the `sampling` capability in the handshake, and an empty `sampling` block does
not, so a server is told the capability is unavailable instead of waiting on a
request nobody answers. `maxTokens` caps the server's requested budget.

Each exchange is recorded — the request as the server sent it (non-text blocks
reduced to their type), the answer or the error, and the wall clock — and the
last `requestLog` of them stay readable at `mcp://<server>/sampling`.

Sampling is text-only. An image, audio or tool block in the request is refused
with an error before the model is called: there is no attachment behind it here,
and silently dropping it would change what the server asked.

## Subscriptions

Changes arrive by subscription, not by polling. Which mechanism a server gets
depends on the protocol era the connection negotiated, and the plugin says which
one it is at `mcp://<server>/subscriptions` rather than pretending they are the
same.

- **Modern** (2026-07-28 and later): every `post` opens a
  `subscriptions/listen` stream on the filter the body names, keeps it, and
  reports the `honoredFilter` the server acknowledged. Change notifications on
  that stream dispatch to the client's notification handlers and land in the
  per-server event ring.
- **Legacy**: `listen` refuses with the SDK's typed
  `MethodNotSupportedByProtocolVersion`, and the plugin falls back to
  `resources/subscribe` and `resources/unsubscribe` for resources, and to
  `ClientOptions.listChanged` for list changes when the server advertises
  `<list>.listChanged`. A list subscription on this era opens no stream; it
  records that the client's own handlers carry the changes.

Three bodies, one address:

| body | effect |
|---|---|
| `{"resource": "<uri>"}` | subscribe that resource; re-open the stream on the era |
| `{"resource": "<uri>", "remove": true}` | close the stream, or `resources/unsubscribe` on the legacy era |
| `{"lists": true}` (`false` closes) | open the list-change subscription |

Anything else is refused with the accepted forms named. Subscriptions the caller
asked for survive a reconnection: the wanted set is kept, and the supervisor
re-opens it on the new connection.

Every notification, connection and subscription change is recorded in a bounded
ring, newest first at `mcp://bus` with kind, server and timestamp. `watch`
streams that ring:

- `mcp://<server>/events` yields one JSON line per **new** event. Events already
  in the ring when the watch opens are not replayed; read `mcp://bus` for
  history.
- `mcp://<server>/tools`, `/resources` and `/prompts` yield a line
  `{at, server, list, count}` when that listing comes back different from the
  previous fetch.

Aborting the caller's signal ends the iteration, and breaking out of the loop
releases the listener the same way.

## Connection supervisor

A ticker per server, every `heartbeatMs`, does only what a subscription cannot:

- reconnects a server that is down, after an exponential backoff from
  `retryBaseMs`, doubling on each failure and capped by `retryMaxMs`;
- re-opens the listen streams and resource subscriptions the caller wants, on
  the connection that is now live.

Listing refresh is a second, separate knob. `resyncMs` defaults to `0`, which
means no refresh on a timer at all: the listings follow the subscriptions. Set
it when a server's `listChanged` cannot be trusted, and the supervisor will
refresh a listing that has not been refreshed within `resyncMs`.

`heartbeatMs: 0` starts no timer, and `tick()` is exported for a host that
wants to drive the supervisor itself. A tick never overlaps itself, and path
operations share the one in-flight connection attempt instead of racing it.
Disposing the plugin clears the timer, closes the listen streams and the client,
and withdraws the server from the source.

A server counts as down when its first connection attempt failed or when its
connection closed on its own; only those schedule a reconnect. A call that fails
on a connection that is still open is reported to the caller and leaves the
connection alone.

## Configuration

One entry per server. The shape matches upstream `@deepseek-ai/dsh-mcp-client`
for the transport fields, so a row or a connector can point at this plugin
without rewriting its config.

```yaml
- id: omd-mcp-paths
  name: omd-mcp-paths
  config:
    serverName: magpie
    transport: stdio
    command: /Applications/magpie.app/Contents/MacOS/magpie
    args: [mcp, image]
    sampling:
      provider: magpie
      model: group/decider
      maxTokens: 2048
```

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | publish this server under the source |
| `serverName` | required | one path segment, `[A-Za-z0-9_-]{1,32}`; `bus` is reserved |
| `transport` | `stdio` | `stdio` or `streamable-http` |
| `command`, `args`, `env`, `cwd` | — | the spawned server under `stdio` |
| `url`, `headers` | — | the endpoint under `streamable-http`; credentials belong here, never in a path |
| `toolCallTimeoutMs` | `60000` | budget for one tool call, prompt render, resource read or template instantiation |
| `failOnStartupError` | `false` | reject the entry when the first connection fails, instead of retrying from the supervisor |
| `sampling.provider`, `sampling.model` | — | both set advertises sampling and answers it on that route |
| `sampling.maxTokens` | — | ceiling on generated tokens |
| `requestLog` | `20` | sampling exchanges kept at `mcp://<server>/sampling`; `0` keeps none |
| `heartbeatMs` | `15000` | supervisor interval: reconnect and re-open subscriptions; `0` starts no timer |
| `resyncMs` | `0` | listing resync interval, checked on each supervisor tick; `0` never resyncs |
| `retryBaseMs` | `1000` | first reconnect delay |
| `retryMaxMs` | `60000` | cap on the reconnect delay |

The parent environment handed to a spawned server drops credential-shaped names
(`TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `DSH_*`); an explicit `env`
entry is layered over that.

## Model Experience

The model sees one more line in the `dsh-resource://` roster, not one tool per
MCP tool. Discovery costs a read of the server, a read of a listing, and a read
of one entry for its schema; a call is one GET or one POST. Compared with
registering every MCP tool, the request header stays small and a server with
hundreds of tools costs the same as one with three — the cost moves to the turns
where the model actually reads a path.

## Known Limitations and Deferred Work

- **Sampling is text-only and has no client-side deadline.** A route that
  stalls stalls that one server request; the harness's own model timeout is the
  only guard.
- **List changes need the server to advertise them.** `ClientOptions.listChanged`
  is only wired for a list the server declares, so a server that changes its
  tools without `tools.listChanged` is only picked up by `resyncMs`.
- **One refresh per notification.** `autoRefresh` is off, so a
  `tools/list_changed` triggers this module's own refresh, which fetches all
  three listings; three list notifications in a row cost three refreshes.
- **One process-wide registry.** Two profile entries with the same `serverName`
  are rejected at load, so a name stays a single path segment.
- **`read` reports documentation only.** A payload larger than one message is
  the caller's problem: `get` returns it whole, with no windowing.
