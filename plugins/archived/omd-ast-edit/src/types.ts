/**
 * Service vocabulary and tool values for `omd-ast-edit`.
 *
 * The filesystem shapes are copied by hand rather than imported: this plugin is
 * out of tree and must not depend on `@deepseek-ai/dsh-fs` being resolvable in
 * its own directory. They describe the four calls the commit path makes — nothing
 * more — so a backend that implements the real contract satisfies them.
 *
 * @module omd-ast-edit/types
 */

/** A resolved file target, as `ctx.fs.resolve` returns it. */
export interface FsTargetLike {
  readonly targetKey: string
  readonly displayPath: string
}

/** File metadata, as `ctx.fs.stat` returns it. */
export interface FsInfoLike {
  readonly version: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** Result of a guarded write, as `ctx.fs.writeText` returns it. */
export interface FsWriteOutcomeLike {
  readonly version: string
  readonly before: string | null
  readonly after: string
}

/** The slice of `ctx.fs` this plugin commits through. */
export interface FileSystemServiceLike {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetLike>
  stat(target: FsTargetLike, signal?: AbortSignal): Promise<FsInfoLike | undefined>
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>
  writeText(
    target: FsTargetLike,
    content: string,
    expected?: { kind: 'replaceIfVersion'; version: string },
    signal?: AbortSignal,
  ): Promise<FsWriteOutcomeLike>
}

/** Line counts for one file in an `ast_apply` result. */
export interface AppliedFile {
  path: string
  added: number
  removed: number
}

/** Value `ast_edit` returns. The write never happens here. */
export interface AstEditValue {
  callId: string
  files: string[]
  replacements: number
  staged: true
}

/** Value `ast_apply` returns after committing. */
export interface AstApplyValue {
  applied: number
  files: AppliedFile[]
  stale?: boolean
  extra?: boolean
  delta?: number
}
