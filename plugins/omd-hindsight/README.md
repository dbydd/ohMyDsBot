---
kind: reference
---

# omd-hindsight

Hindsight durable memory for dsh, adapted from [omp-hindsight](https://github.com/dbydd/omp-hindsight) 0.1.2, commit `984e314`. The package contains the host adapter and its plain JavaScript web client. DS-Bot and the installed dsh runtime remain upstream dependencies.

The Hindsight HTTP service owns facts, documents, knowledge pages, mental models, and asynchronous operations. This plugin owns project configuration, the local retry queue, and session contributions. It does not maintain a separate memory database.

## Model Experience

The model receives one `hindsight` tool with four parameters: `intent`, `content`, `file`, and `target`. The intent and target describe the requested operation. The content and file bytes stay outside the routing judge's input. Tool decisions use the existing `omd-judgment` service, and receipts include `hindsight://` addresses.

```text
hindsight(intent="recall the decision about worker ownership", target="coding")
hindsight(intent="store the verified deployment cause", content="…", target="coding")
```

A bank section describes each bank's purpose, access level, and write policy. Subagents receive read-only access. A bank with `autoTarget: false` requires an explicit target for writes.

Automatic recall runs at the model's step boundary. It samples the user's task and recent conversation, applies the configured frequency, interval, debounce, ranking, and duplicate filters, and contributes sourced context before the request is prepared. A recalled fact is recorded in the session before the model sees it. Recall does not submit a follow-up turn or wake an idle agent.

The model-visible payload follows the reference format:

```text
<hindsight_memories>
- [coding] (world) A fact returned by Hindsight.
  evidence: hindsight://coding/facts/<id>
- [coding] (anti-pattern · past failed attempt, do not retry) A recorded failure.
  evidence: hindsight://coding/chunks/<id>
</hindsight_memories>
```

The configured preamble precedes the fence. Evidence prefers the backing chunk address when one is available. Automatic recall failures leave the original user input intact and report the cause through the host logger.

`recallInjectJudge` controls the injection decision, and `recallRerankJudge` controls candidate reranking. With both disabled, automatic recall uses the programmatic ranking path and makes no judgment calls. Tool actions retain their routing and permission checks.

The bank recall token budgets, selected fact count, and rendered facts determine the added request size. The recall cache and per-session duplicate tracking prevent the same material from accumulating during a tool loop. Injected context has its own source and appears as a memory card in the web conversation.

## Web interface

The Hindsight strip sits above the composer alongside the context strip. It shows connection health, the configured bank count and names, the pending retain queue count, and buttons for settings and the queue. It refreshes from the host resource and follows the current session's project.

The settings panel renders fields from the host configuration schema. Values are project overrides of the profile row. A save carries the revision read by the form; a stale revision reports a conflict and preserves the draft. API credentials remain environment-variable references.

The queue panel lists pending and failed entries with their state, attempt count, and last error. Its retry action uses the host's queue processor and reports sent, pending, and failed entries. Concurrent retry requests share one replay operation.

Injected memories render in a dedicated **HINDSIGHT CONTEXT GUIDELINES** card. Each fact shows its bank and type, and anti-pattern facts have warning styling. Evidence links read the same internal resource provider that model tools use. The card is a view of the logged source details, not a second copy of authoritative memory.

## Internal resources

All resources are owned by the `hindsight` source and support the `hindsight://` shorthand.

| Address | Representation |
|---|---|
| `hindsight://` | Bank roster, descriptions, access, and backend health |
| `hindsight://<bank>` | Bank overview |
| `hindsight://<bank>/facts[/<id>]` | Facts or one fact |
| `hindsight://<bank>/documents[/<id>]` | Documents or one document |
| `hindsight://<bank>/chunks[/<id>]` | Evidence chunks or one chunk |
| `hindsight://<bank>/knowledge-base[/pages/<id>]` | Knowledge pages |
| `hindsight://<bank>/mental-models[/<id>]` | Mental models |
| `hindsight://<bank>/operations[/<id>]` | Remote operation state |
| `hindsight://<bank>/stats` | Bank statistics |
| `hindsight://plugin/config` | Resolved configuration description |
| `hindsight://plugin/status` | JSON connection, bank, and queue status for the web strip |
| `hindsight://plugin/project-config` | JSON project, revision, overrides, effective values, and editable schema |
| `hindsight://plugin/queue` | JSON pending and failed retry entries |
| `hindsight://plugin/operations` | Recent tool operations in this process |
| `hindsight://queue[/<id>]` | Human-readable retry queue or one entry |

Exact inventory and configuration reads require no routing judgment. Browser reads pass the selected session to `/api/paths`, so project-bound resources resolve against that session's working directory.

The project-config resource accepts a POST with `intent`, `expectedRevision`, and `values`. The queue resource accepts a POST with `intent` and `action: "retry"`. Both use the host action provider and its judgment and permission checks. Judgment metadata excludes setting payloads and queued memory bodies.

The existing `/api/plugins/omd-hindsight/project-config` GET/POST route uses the same project store and resolver for existing settings clients.

## Configuration

Configure the backend and bank roster in the profile:

```yaml
- id: omd-hindsight
  name: omd-hindsight
  config:
    baseUrl: http://localhost:8888
    apiKeyEnvVar: HINDSIGHT_API_KEY
    banks:
      coding:
        bankId: my-project-memory
        description: Engineering conclusions and decisions for this project
        access: read-write
        retain: manual
      reference:
        bankId: reference-library
        description: Reference facts and supporting evidence
        access: read
        retain: off
        autoTarget: false
    defaultBank: coding
    recallInjectJudge: false
    recallRerankJudge: false
```

The profile supplies deployment-specific URLs, bank IDs, and model routes. The environment variable supplies the credential value. The plugin validates the roster and uses the core configuration parser for recall limits and policies.

Project overrides are sparse. An absent field keeps the profile value. The settings schema exposes the supported fields and their constraints, including recall budget, debounce, and the judgment switches. Changes use the same resolution path for tools, recall, resource reads, and the web panel.

The project store lives under `<dsh home>/data/omd-hindsight/projects/<sha256(project)>.json`. Writes are serialized per project, revision-checked, and atomic. A project path is the session's absolute working directory.

## Lifecycle and ownership

Cordis owns registrations, listeners, and their disposal. The browser client uses the web module-loader factory and declares `dsh.client.platform: web`; it imports no Node built-ins. The host owns HTTP clients, queue replay, configuration, and recall. The client owns form drafts and rendering.

Queue entries preserve the retain arguments needed for replay. A failed submission remains pending or moves to failed according to the reference attempt policy. A successful replay removes its pending entry. The memory service remains the owner of extraction and operation completion.

## Known Limitations and Deferred Work

Hindsight service availability bounds recall and retain. An automatic recall failure does not stop the user's task; explicit actions return their error or retry receipt.

Injected facts consume context and remain historical evidence of what the model received. Updating a remote fact does not rewrite earlier session messages. The configured limits and duplicate tracking govern subsequent injections.

The web client uses dsh conversation extension points. It adapts the reference terminal status widget, sheet, and custom message renderer to browser components. It does not load omp's terminal runtime into dsh.
