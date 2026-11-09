/**
 * omd-ast-edit — two-phase structural rewrite, on top of the shared ast-grep
 * engine that `omd-core` mounts via `dsh-tool-ast-grep`.
 *
 * The community tool only searches, which is half a rewrite. Here the halves are
 * separate calls: `ast_edit` finds and records sites and writes nothing, so the
 * blast radius is readable before anything lands; `ast_apply` re-runs that same
 * query against the live tree and commits what still matches. The staging table
 * is keyed by the call id `ast_edit` reports, so a model that stages several
 * queries applies them one at a time, and each agent keeps its own records.
 *
 * Committing is guarded at both ends: the record is re-derived from the live
 * tree rather than replayed, and a site whose recorded text no longer occupies
 * its recorded byte range is skipped and reported as `stale`, instead of the
 * rewrite splicing across a range the user has since edited.
 *
 * @module omd-ast-edit
 */

import { resolve } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { DEFAULT_ENGINE_TIMEOUT_MS, findSites, type AstSite } from './engine.ts'
import { compareSites, spliceSites, type StagedEdit } from './staged.ts'
import type { AppliedFile, AstApplyValue, AstEditValue, FileSystemServiceLike } from './types.ts'

/** Bundle name, so a profile patch row can name this plugin. */
export const name = 'omd-ast-edit'

/** Tools is the only service this plugin needs at load time. */
export const inject = ['tools']

/** Deployment settings for the two-phase rewrite. */
export interface Config {
  /** Files `ast_edit` accepts before it refuses to stage, when the call names no `maxFiles`. */
  defaultMaxFiles: Volatile<number>
  /** Budget for one ast-grep run, in milliseconds. */
  engineTimeoutMs: Volatile<number>
  /**
   * Budget the host gives one `ast_edit`/`ast_apply` call. It covers the engine
   * run plus the file reads and writes; keep it above `engineTimeoutMs`.
   */
  toolTimeoutMs: number
}

export const Config: z<Config> = z.object({
  defaultMaxFiles: z.number().step(1).min(1).default(1000)
    .volatile()
    .description('Files ast_edit accepts before it refuses to stage, when the call names no maxFiles.'),
  engineTimeoutMs: z.number().step(1).min(1).default(DEFAULT_ENGINE_TIMEOUT_MS)
    .volatile()
    .description('Budget for one ast-grep run, in milliseconds.'),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_ENGINE_TIMEOUT_MS + 30_000)
    .description('Budget for one ast_edit/ast_apply call, in milliseconds; keep it above engineTimeoutMs.'),
})

/**
 * Register the staging and commit tools.
 * @param ctx - context carrying the tool registry.
 * @param config - deployment settings for this profile.
 */
export function apply(ctx: Context, config: Config): void {
  const stagedByAgent = new Map<Agent, Map<string, StagedEdit>>()
  const stagedUnscoped = new Map<string, StagedEdit>()

  /**
   * The staging table for one agent, created on first use and dropped through
   * that agent's own effect, so a disposed agent cannot keep a record alive.
   * Agents that already exist when this plugin loads get theirs on first call.
   * @param agent - the calling agent, or `undefined` for an agentless call.
   * @returns its staging table.
   */
  const bagFor = (agent: Agent | undefined): Map<string, StagedEdit> => {
    if (agent === undefined) return stagedUnscoped
    const existing = stagedByAgent.get(agent)
    if (existing !== undefined) return existing
    const bag = new Map<string, StagedEdit>()
    stagedByAgent.set(agent, bag)
    agent.ctx.effect(() => () => { stagedByAgent.delete(agent) })
    return bag
  }

  ctx.on('agent/created', ({ agent }) => {
    bagFor(agent)
  })
  ctx.effect(() => () => {
    stagedByAgent.clear()
    stagedUnscoped.clear()
  })

  const rootFor = (agent: Agent | undefined): string => agent?.session.header.cwd ?? process.cwd()

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ast_edit',
    description:
      'Stage a structural rewrite WITHOUT writing it. Searches the workspace with ast-grep, '
      + 'records every matched site in memory, and returns a callId plus the touched files. '
      + 'It never modifies a file, so the worktree is byte-identical when it returns. '
      + 'You MUST call ast_apply with the returned callId for the changes to land; '
      + 'staging alone is a no-op. Patterns: $VAR matches one node, $$$ matches many. '
      + 'Use glob to scope the search.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Structural pattern, e.g. `function $NAME($$$) { $$$ }` or `console.log($VALUE)`.',
      },
      replacement: {
        type: 'string',
        required: true,
        description:
          'Replacement template using the same meta-variables, e.g. `const $NAME = (...) => { $$$ }`. '
          + 'An empty string deletes every match.',
      },
      glob: {
        type: 'string',
        required: true,
        description: 'File filter, e.g. `src/**/*.ts` or `!tests/**`. Applies to both ast_edit and ast_apply.',
      },
      maxFiles: {
        type: 'integer',
        description: `Refuse to stage when more files than this match. Defaults to ${config.defaultMaxFiles.get()}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          callId: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          replacements: { type: 'integer', required: true },
          staged: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const body = [
          `Staged ${value.replacements} replacement${value.replacements === 1 ? '' : 's'} in `
            + `${value.files.length} file${value.files.length === 1 ? '' : 's'}; nothing was written.`,
          `Call ast_apply with callId ${value.callId} to commit this staging.`,
          value.files.length > 0 ? `Files:\n${value.files.map(file => `- ${file}`).join('\n')}` : '',
        ].filter(Boolean)
        return [{ type: 'text', text: body.join('\n') }]
      },
    },
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      if (args.pattern.trim().length === 0) {
        throw new Error('ast_edit: pattern must be a non-empty structural pattern')
      }
      const root = rootFor(exec.agent)
      const sites = await findSites({
        pattern: args.pattern,
        replacement: args.replacement,
        glob: args.glob,
        root,
        signal: exec.signal,
        timeoutMs: config.engineTimeoutMs.get(),
      })
      if (sites.length === 0) {
        throw new Error(
          `ast_edit: no matches for pattern ${JSON.stringify(args.pattern)} under ${JSON.stringify(args.glob)}`,
        )
      }

      const files = new Map<string, number>()
      for (const site of sites) files.set(site.file, (files.get(site.file) ?? 0) + 1)
      const fileNames = [...files.keys()].sort()
      const maxFiles = args.maxFiles ?? config.defaultMaxFiles.get()
      if (fileNames.length > maxFiles) {
        throw new Error(
          `ast_edit: ${fileNames.length} files matched, more than maxFiles=${maxFiles}; `
          + 'narrow the glob or raise maxFiles',
        )
      }

      bagFor(exec.agent).set(exec.callId, {
        pattern: args.pattern,
        replacement: args.replacement,
        glob: args.glob,
        root,
        sites,
      })
      const value: AstEditValue = {
        callId: exec.callId,
        files: fileNames,
        replacements: sites.length,
        staged: true,
      }
      return value
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ast_apply',
    description:
      'Commit a staged ast_edit. ast_edit stages without writing, so this call is the only one '
      + 'that touches files: it re-runs the staged query against the current tree and writes the '
      + 'matches it still finds. If no site matches anymore the call fails and nothing is written; '
      + 'if some sites moved or vanished, the surviving ones are applied and the result reports stale.',
    parameters: {
      callId: {
        type: 'string',
        required: true,
        description: 'The callId returned by the ast_edit call whose staging you want to commit.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'integer', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                added: { type: 'integer', required: true },
                removed: { type: 'integer', required: true },
              },
            },
          },
          stale: { type: 'boolean' },
          extra: { type: 'boolean' },
          delta: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const body = [
          `Applied ${value.applied} replacement${value.applied === 1 ? '' : 's'} across `
            + `${value.files.length} file${value.files.length === 1 ? '' : 's'}.`,
          value.stale === true
            ? 'The staging was stale: at least one recorded site no longer matches, so only the '
              + 'surviving sites were written. Run ast_edit again to stage the current tree.'
            : '',
          value.extra === true
            ? `${value.delta} new site${value.delta === 1 ? '' : 's'} matched since staging; every match was applied.`
            : '',
          value.files.length > 0
            ? value.files.map(file => `- ${file.path}: +${file.added} / -${file.removed}`).join('\n')
            : '',
        ].filter(Boolean)
        return [{ type: 'text', text: body.join('\n') }]
      },
    },
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const bag = bagFor(exec.agent)
      const staged = bag.get(args.callId)
      if (staged === undefined) {
        const known = [...bag.keys()]
        throw new Error(
          `ast_apply: no staged edit for callId ${args.callId}`
          + (known.length > 0 ? `; staged in this agent: ${known.join(', ')}` : '; nothing is staged in this agent')
          + '. Run ast_edit first and pass back the callId it returned.',
        )
      }

      const fresh = await findSites({
        pattern: staged.pattern,
        replacement: staged.replacement,
        glob: staged.glob,
        root: staged.root,
        signal: exec.signal,
        timeoutMs: config.engineTimeoutMs.get(),
      })
      if (fresh.length === 0) {
        throw new Error('ast_apply: the staged pattern no longer matches; re-run ast_edit')
      }

      const verdict = compareSites(staged.sites, fresh)
      const fileSystem: FileSystemServiceLike | undefined = ctx.get('fs', false)
      if (fileSystem === undefined) {
        throw new Error('ast_apply: the ctx.fs service is not mounted in this profile, so nothing can be written')
      }

      const byFile = new Map<string, AstSite[]>()
      for (const site of fresh) {
        const sites = byFile.get(site.file)
        if (sites === undefined) byFile.set(site.file, [site])
        else sites.push(site)
      }

      const files: AppliedFile[] = []
      let applied = 0
      let skipped = 0
      for (const [file, sites] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        // `file` is root-relative: the engine was always run with cwd set to the root.
        const target = await fileSystem.resolve(resolve(staged.root, file), {
          cwd: staged.root,
          signal: exec.signal,
        })
        const info = await fileSystem.stat(target, exec.signal)
        if (info === undefined || info.type !== 'file') {
          throw new Error(`ast_apply: ${target.displayPath} is not a regular file`)
        }
        const outcome = spliceSites(await fileSystem.readText(target, exec.signal), sites)
        skipped += outcome.skipped
        if (outcome.applied === 0) continue
        await fileSystem.writeText(
          target,
          outcome.text,
          { kind: 'replaceIfVersion', version: info.version },
          exec.signal,
        )
        applied += outcome.applied
        files.push({ path: file, added: outcome.added, removed: outcome.removed })
      }

      if (applied === 0) {
        throw new Error('ast_apply: the staged pattern no longer matches; re-run ast_edit')
      }

      bag.delete(args.callId)
      const value: AstApplyValue = { applied, files }
      if (verdict.kind === 'extra') {
        value.extra = true
        value.delta = verdict.delta
      }
      if (verdict.kind === 'stale' || skipped > 0) value.stale = true
      return value
    },
  })))
}
