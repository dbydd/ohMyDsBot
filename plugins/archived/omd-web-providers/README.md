# omd-web-providers

One dsh plugin bundle that fills `ctx.web` with a roster of search and fetch
backends and two meta-providers that chain them. A vendor outage, a rate limit,
or a rejected key costs one skipped link in the chain instead of a failed
`web_search` / `web_fetch` tool call.

## What it registers

`cordis.patch.yml` pins the deployment's selection to the chain:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: omd-auto
    fetchProvider: omd-auto-fetch
```

| Provider | Capability | Credential | Default |
|---|---|---|---|
| `jina` | search | `JINA_API_KEY` | on |
| `tavily` | search | `TAVILY_API_KEY` | on |
| `tinyfish` | search | `TINYFISH_API_KEY` | **off** |
| `searchinfinity` | search | `SEARCH_INFINITY_API_KEY` | **off** |
| `openalex` | search | none required | on |
| `ddg` | search | none | on |
| `jina-reader` | fetch | `JINA_API_KEY` (optional) | on |
| `firecrawl` | fetch | `FIRECRAWL_API_KEY` | on |
| `omd-auto` | search | — | the chain |
| `omd-auto-fetch` | fetch | — | the chain |

Every child also registers under its own id, so pinning one vendor
(`searchProvider: tavily`) is a one-line override that leaves the rest mounted.

## Chain semantics

**Search** walks `searchOrder` and falls through on transient, quota, network,
invalid-response, and unsupported failures. A **credential**, **config**, or
**aborted** failure is rethrown immediately — a wrong key is a fact the caller
needs, not something to spend silently across the rest of the chain. Every link
failing raises `OMD_SEARCH_EXHAUSTED` with each child's kind and message.

**Fetch** walks `fetchOrder` on *quality*, not only on failure. A body of 100
characters or fewer is discarded; a body carrying a bot-wall marker or mostly
short navigation lines is remembered as the fallback and the chain continues.
The first answer that clears the gate wins. If none does, the remembered
low-quality result is returned — a short page is still readable and an
exception is not — and only a chain with nothing at all raises
`OMD_FETCH_EXHAUSTED`.

Fetch records failures rather than rethrowing them, because each child carries
its own credential: one provider's rejected key is precisely the situation the
other provider exists to survive.

## Credentials

Resolved **per call**, so a rotated key takes effect without a restart. First
non-empty layer wins:

1. `process.env[<ref>]`
2. `<$DSH_HOME or ~/.dsh>/.credentials.yaml` — `name: value` pairs, indented
   or flat
3. `.env` in the invocation directory — `NAME=value`

Resolved values are never logged or embedded in an error message; provider error
bodies are truncated and redacted before they reach a message.

## Private-network guard

`jina-reader` and `firecrawl` run the fetch on **their own** infrastructure, so
handing them `http://169.254.169.254/` would be an SSRF probe against this
machine's network. Both refuse loopback, RFC1918, link-local, CGNAT, `*.local`,
and IPv6 unique-local / link-local targets with `OMD_PRIVATE_URL`, and treat an
unparseable URL as private.

- `allowPrivateUrls: true` disables the guard wholesale.
- `allowRanges` re-opens specific targets — exact IPs or `a.b.c.d/prefix` CIDRs.
  It ships as `['172.19.0.0/16']`, this deployment's container bridge network.

## Configuration

Every knob is a `Config` field (`src/config.ts`); nothing in `src/` hardcodes an
endpoint, a timeout, or a policy.

| Field | Default | Meaning |
|---|---|---|
| `searchOrder` | `jina > tavily > tinyfish > searchinfinity > openalex > ddg` | chain order |
| `fetchOrder` | `jina-reader > firecrawl` | chain order |
| `jinaRef` / `tavilyRef` / `tinyfishRef` / `searchInfinityRef` | the matching env var name | credential reference |
| `openalexRef` | `OPENALEX_API_KEY` | empty ref stays keyless |
| `openalexMailto` | `''` | `mailto` for OpenAlex's polite pool |
| `firecrawlRef` | `FIRECRAWL_API_KEY` | credential reference |
| `*BaseUrl` | `''` | endpoint override; empty selects the vendor's public endpoint |
| `allowPrivateUrls` | `false` | fetch private and loopback URLs |
| `allowRanges` | `['172.19.0.0/16']` | exact IPs / CIDRs exempt from the guard |
| `searchTimeoutMs` | `20000` | per-search budget |
| `fetchTimeoutMs` | `30000` | per-fetch budget |
| `fetchMaxChars` | `200000` | decoded-body cap; longer bodies are cut and flagged |
| `enableJina` / `enableTavily` / `enableOpenalex` / `enableDdg` | `true` | mount that provider |
| `enableTinyfish` / `enableSearchInfinity` | `false` | mount that provider |
| `enableFirecrawl` / `enableJinaReader` | `true` | mount that provider |

## Install

```sh
node plugins/link-host-runtime.mjs          # link @deepseek-ai/dsh-web into plugins/node_modules
dsh plugin --profile <p> add "$PWD/plugins/archived/omd-web-providers"
```

## Known limitations

- **`ddg` is brittle by construction.** It regex-parses
  `html.duckduckgo.com`'s markup, which is neither versioned nor covered by a
  compatibility promise. Zero parsable results raises `invalid-response` rather
  than returning an empty answer, so the chain moves on instead of reporting
  "no results". If it starts failing across a whole page, the markup moved and
  the parser needs updating.
- **`searchinfinity` ships disabled** and its key does not currently work. The
  request/response shape is confirmed against BytePlus's official docs, but a
  live probe returned `CodeN 700901 / invalid_api_key` for the
  `SEARCH_INFINITY_API_KEY` in this environment — a key with Searchinfinity
  access is issued from
  [console.byteplus.com](https://console.byteplus.com/search-infinity/api-key).
  It answers **HTTP 200 for failures**, with the error in
  `ResponseMetadata.Error`; the provider maps those in-body codes to failure
  kinds itself.
- **`tinyfish` ships disabled** so a deployment is not billed on an
  under-exercised path. Its shape was verified live
  (`GET https://api.search.tinyfish.ai?query=…`, `X-API-Key` header, ten results
  per page). Enable it with `enableTinyfish: true`.
- **Jina Reader without a key is rate-limited by IP.** Anonymous use works but
  a bad network reputation gets `401`; the chain then falls through to
  Firecrawl.
- **Search responses carry no generated answer.** `content` is left unset: Jina
  runs with `X-Respond-With: no-content` and Tavily with `include_answer:
  false`, because the seam's callers ask for citeable sources, not for a second
  billed model call.
- **OpenAlex abstracts are reconstructed from the inverted index**, which drops
  the original punctuation. Works with no abstract come back without a snippet.
