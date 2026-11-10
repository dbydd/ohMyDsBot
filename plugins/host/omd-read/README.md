# omd-read

The `read` tool: omp-style path selectors (`a.ts:50-200`, `:-60`, `:5-16,900-910`,
`:raw`), inline images, and internal path sources over `ctx.fs`. It replaces the
upstream `read` and `read_image` pair; the profile disables `tool-fs`'s `read` and
`readImage` and mounts this tool instead.

The agent-scoped `read` shadows the inherited definition. The plugin restricts
only inherited `read_image`; the tool runtime rejects restrictions on a name
registered in the agent's own scope. Other plugins add execution policies
through `tools/execute` without registering a second `read` in that scope.

Internal paths live in `omd-internal-paths`; this package registers the `skill`
source (`skill://<name>`, `dsh-resource://skill/<name>`) as the first consumer.

Image detection reads a 12-byte window with `readByteRange`. The bytes decide
whether a file is an image, so a `.png` holding text reads as text and a PNG
named `.txt` still reads as an image; the extension only decides whether an
extensionless file is worth opening, and stands in when the window cannot be
read at all. `maxBytes` caps the text window and never gates the image branch —
images are bounded by `attachments.imageLimits`.

A source that resolves a layered host service must pass the caller's full
lookup — `{ cwd, signal, scope: agent }` — because a `ctx.get(name)` read without
the agent's scope resolves the global layer alone and reports present data as
missing. See `docs/omd-internal-paths.md`.
