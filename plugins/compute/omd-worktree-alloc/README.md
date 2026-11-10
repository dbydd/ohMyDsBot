# omd-worktree-alloc

Isolated working trees for child agents, plus the collector that lands their
work back in the parent directory. It publishes `ctx.worktreeAlloc`.

The upstream `@deepseek-ai/dsh-experimental-worktree` service ends `create()`
with `workingDirectory.set(agent, path)`
(`packages/experimental/worktree/src/index.ts:170`). That is right for a command
whose purpose is to move a session, and wrong for a parent handing an isolated
tree to a child: the parent would end up working inside the child's checkout.
This package performs the same work with the last step removed. No method here
calls `process.chdir` or touches the `workingDirectory` projection; the tree is
described by the returned path alone.

## How a tree is made

One materialisation: an APFS clonefile copy of the directory the caller names.

A copy is cheap because `cp -cR` asks the filesystem for a copy-on-write clone
instead of copying bytes: the second tree costs metadata and only diverges where
it is written. The copy carries everything — `.git`, ignored directories,
untracked files, installed dependencies — so a child starts where its parent is,
including the parent's uncommitted work.

Two copies are made, not one. The first is the baseline, an untouched clone of
the source; the second is the working copy handed to the child, cloned from the
baseline so the two start byte-identical. Neither is a repository: a workspace
that was never under version control works exactly like a checkout does.

```ts
const tree = await ctx.worktreeAlloc.allocate('omd/task/child-1', directory)
// tree.path       → the isolated directory; pass it as the child's cwd
// tree.name       → 'omd/task/child-1', the copy's path below the pool
// tree.sourceRoot → the directory patches are applied back to
// tree.baseline   → the untouched copy, its index digest, entries and bytes
```

`allocate(name, cwd)`: `cwd` is the directory to copy and defaults to the
process working directory, which is only read. The copy lands at
`<source>/<cloneDirectory>/<name>`, with its baseline beside it as
`<name>.baseline`. A name that would escape the pool, or end in `.baseline`, is
refused before anything is created, and a failure after the copy starts removes
the copies again.

## Collecting

`collect` diffs the working copy against the baseline captured at allocation —
never against the source, so the source's own edits are not attributed to the
child.

The result is a unified diff with `diff --git` headers, produced by walking both
trees: size and mtime decide most paths, and only a path whose metadata still
matches is read and compared byte for byte, so a `touch` produces no hunk.
Symlinks are carried as `120000` entries, and an executable-bit change becomes
`old mode`/`new mode`. A binary change is reported as git's
`Binary files … differ` notice and refuses to land: a text patch cannot carry
it, and truncating one would be worse.

A copy can host a nested allocation, whose pool sits at
`<copy>/<cloneDirectory>`. That subtree is excluded from the walk, so a
grandchild's files are never attributed to its parent.

`cow.ts` also exposes the richer result:

```ts
import { collectCowChanges } from 'omd-worktree-alloc'

const { patch, files, summary } = await collectCowChanges(tree.baseline, tree.path, {
  maxBytes: 8_388_608,
  timeoutMs: 60_000,
})
```

## Applying

`apply` is serialised per allocator, dry-runs the whole patch, and writes nothing
when git refuses: a source that edited the same lines gets `conflict` with the
list of files git refused, and its files stay exactly as they were. It uses
`git apply`, which needs the git binary but no repository — which is what lets a
plain directory be patched. The patch carries no blob names, so a three-way
merge is not available: a patch whose context does not apply is refused, not
merged.

Orphaned trees from earlier runs are swept before the patch is generated, so a
caller that keeps applying does not also need a timer.

## Releasing

`release` removes the working copy and its baseline: they are one unit, and
neither is recoverable from the other. Both paths must be inside the pool, or
nothing is removed. `sweep` removes entries older than `idleTtl` that this
process does not hold, recognising them by the `<name>.baseline` sibling; a
baseline whose working copy is already gone is reclaimed too, since nothing else
ever would.

## Configuration

| field | default | meaning |
|---|---|---|
| `cloneDirectory` | `.omd/clones` | Pool for the copies, relative to the directory being copied. A copied checkout does not see it in `git status`: the pool writes its own `.gitignore`. |
| `baselineMaxBytes` | `8388608` | Ceiling on the baseline file index. Crossing it fails the allocation and removes the copies. |
| `patchMaxBytes` | `8388608` | Ceiling on one collected patch. Crossing it fails the collect instead of truncating. |
| `timeoutMs` | `60000` | Deadline per `cp`, `diff`, and `git apply` invocation. |
| `metadataMaxBytes` | `65536` | stdout ceiling for git invocations that answer with an explanation. |
| `idleTtl` | `3600` | Seconds an unheld, untouched pool entry may sit before a sweep removes it. Volatile. |

```yaml
- insert:
    - id: omd-worktree-alloc
      name: omd-worktree-alloc
```

`cloneDirectory` must be relative and dot-segment free.

## Known limits

- **No history and no branch.** The copy is a directory, not a commit: there is
  nothing to log, nothing to check out, and nothing to push. A run's record is
  the patch `collect` returns and the files it names.
- **An allocation needs APFS.** It refuses to fall back to a byte copy; a silent
  full copy of a dependency tree is not a behaviour anyone asked for.
- **Two copies per allocation.** Both are clonefile clones, so the second costs
  metadata until either side is written; on a tree that changes wholesale it
  costs the changed files twice.
- **A binary-heavy change set hits the patch bound.** Binary content is reported
  by name and byte counts, never carried, so a change set made mostly of binary
  files either fails `patchMaxBytes` or lands as notices that write nothing.
- **A linked worktree is refused.** Its `.git` points into another checkout's
  administration directory, so a copy would edit the original's refs and index.
- **No ignore rules.** Everything below the source is copied and compared,
  except the pool itself. A large ignored directory becomes part of every index
  and every walk.
- **`apply` needs the git binary.** `collect` does not.
- **Sweeping is best-effort.** An entry a second process is holding still looks
  idle to this one if its mtime ages; the timer logs failures instead of failing
  a caller.

## Checks

```sh
cd plugins/compute/omd-worktree-alloc && tsc --noEmit -p tsconfig.json
```

This reports three diagnostics that are present at `HEAD` as well: the
schemastery `Schema<Config>` variance complaint and two cordis `Context` members
(`provide`, `effect`) resolving to static members. They come from the host type
packages this checkout links, not from this package's own code.

The path is exercised by running the allocator from a throwaway script: allocate
from a directory with files and a subdirectory, write and modify files inside the
copy, `collect`, `apply` onto a fresh copy of the source, and compare the two
trees byte for byte. `baselineMaxBytes` and `patchMaxBytes` each cross their
budget with a named error, and a failed allocation leaves no copy behind.
