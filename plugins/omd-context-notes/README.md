# omd-context-notes

Working-memory notebook and prompt section for dsh, featuring a two-part markdown convention (`# Shared` and `# Agent notes`), child section allocation for subagents, projection-backed persistence, internal paths, and a Markdown tab in DS-Bot's existing details sidebar.

## Structure and Contract

- **First `#` section (`# Shared`)**: Shared and collaboratively editable by both human user and model.
- **Second `#` section onwards (`# Agent notes`)**: Agent working memory and scratchpad. The browser editor presents the full original document.
- **Child subagent subsections (`<!-- section:<childId> -->\n## <Title>`)**: Subagents allocated a notebook section in `omd-task` receive write permissions strictly scoped to their assigned subsection within the parent notebook's `# Agent notes` area. Sibling sections, parent scratchpad, and the shared area remain read-only for that child.
- Heading-like lines inside fenced code blocks (` ``` ` or `~~~`) are ignored.
- Default empty initial content: `# Shared\n\n# Agent notes\n`.
- Safe migration: unstructured existing notebook content is preserved in the agent notes section rather than discarded.

## Host Capabilities

- **Projection `contextNotes`**: Folds `plugin:omd-context-notes/updated` session events into immutable snapshots (`text`, `bytes`, `version`).
- **Prompt section `omd:context-notes`**: Injects latest notebook revision into the assembled system prompt with discipline instructions pointing to internal paths.
- **Internal path source `dsh-resource://notebook/...`** (shorthand `notebook://...`):
  - `notebook://<sessionId>/notes.md`: Read/write full notebook (protected against race conditions).
  - `notebook://<sessionId>/shared.md`: Read/write shared section (with expectedVersion concurrency check).
  - `notebook://<sessionId>/agent.md`: Read/write agent section.
  - `notebook://<parentSessionId>/sections/<childId>.md`: Dedicated child subsection path for allocated subagents.
- **Host service `ctx.contextNotes`**:
  - `pathFor(parentSessionId: string, childSessionId?: string): string`
  - `read(sessionId: string): Promise<ReadNotesResult>`
  - `readSection(sessionId: string, childSessionId: string): Promise<string>`
  - `write(request: NotebookWriteRequest): Promise<WriteNotesResult>` (unified choke point enforcing origin, identity, permissions, and concurrency)
  - `saveShared(sessionId: string, sharedText: string, expectedVersion: number): Promise<WriteNotesResult>`
  - `saveAgent(sessionId: string, agentText: string): Promise<WriteNotesResult>`
  - `saveFull(sessionId: string, fullText: string, expectedVersion?: number): Promise<WriteNotesResult>`
  - `saveChildSection(parentSessionId: string, childSessionId: string, content: string, callerSessionId?: string): Promise<WriteNotesResult>`
  - `allocate(childSessionId: string, options?): { path: string; dispose: () => void }` (records grant, grants scoped permission, and revokes write upon disposal while retaining notes).

## Browser UI

- Hand-authored plain JS module loader client entry in `src/client/index.js` loaded via `window.__ModuleLoader__`.
- Registers a disposable `omd-context-notes` tab through `window.dshBot.registerDetailsTab`, alongside Details and Browser. DS-Bot owns panel sizing, closing, and session following. The editor uses a 4:3 surface with internal scrolling, global DSH `--dsw-*` tokens, and live en/zh locale switching via `ctx.locale`.
- Reuses DSH official platform-seeded renderer `MarkdownText` from `@deepseek-ai/dsh-client-ui-primitives` mounted via `react-dom/client` `createRoot` for complete, rich GFM rendering (headings, emphasis, links, lists, code fences, and tables).
- Seamless interactive editing: initial visible view is rich text; clicking the view or the Edit button toggles into the raw source editor for precise Markdown editing.
- Untouched source text is preserved byte-for-byte; round-trip saves use `expectedVersion` concurrency check.
- Binds to the current conversation part passed by DS-Bot's details panel.
- Draft-safe editing: user drafts are retained during background updates, and save targets the session the draft was authored for.
- Concurrency conflict UX: visible conflict alert explaining concurrent modifications, retaining draft, and providing overwrite/discard options.
- Clean lifecycle teardown of timers, subscriptions, React roots, and DOM elements.
