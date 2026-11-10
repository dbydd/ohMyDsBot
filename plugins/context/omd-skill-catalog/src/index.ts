/**
 * `omd-skill-catalog` — the session skill catalog with `read skill://<name>`
 * as the only way to load a skill.
 *
 * Upstream `dsh-tool-skill` owns both halves of skill discovery: the durable
 * session catalog and the model-facing `skill` loader. Its catalog is emitted
 * only while the calling agent's tool view still resolves that plugin's exact
 * `skill` registration, so a plain `tools.restrict({ deny: ['skill'] })` would
 * take the list away with the verb and leave the model holding `read` with no
 * names to call it on. This plugin splits the pair: it denies the loader on
 * every agent that inherited it, and publishes the catalog itself.
 *
 * The catalog keeps upstream's injection shape — one sourced user message,
 * `form: 'catalog'`, the same `<available_skills>` framing — so the client
 * renders it as the catalog row it replaces and the model reads the same
 * guidance, with `read skill://<name>` where the tool call used to be.
 *
 * ## Why the source kind is ours
 *
 * The catalog is sourced as `omd-skill-catalog`, not upstream's
 * `skill-catalog`. Upstream's listeners stay mounted after the deny: with the
 * loader gone they compute an empty catalog at every pre-step, and with a
 * shared kind they would recognize this plugin's message as their own and
 * replace it with "no skills are available". Under a distinct kind they have
 * nothing to recognize, their `published` flag never becomes true, and they
 * stay silent.
 *
 * That is also the rule when the deny does not take: if `skill` is still
 * resolvable after the restriction (a registration in the agent's own scope,
 * which a scope's own filter cannot mask), this plugin governs nothing for
 * that agent and upstream's catalog, matched to the still-visible tool, is
 * authoritative. One catalog, from whichever side still has the verb.
 *
 * A session written before this plugin ran still carries an upstream
 * `skill-catalog` message. Upstream then emits one empty replacement, which is
 * wrong by construction once the tool is denied, so the pre-step listener —
 * prepended, and therefore outermost — drops that kind from every step's
 * messages. Our first publication in such a session uses the replacement
 * framing, because earlier lists do exist in the log.
 *
 * @module omd-skill-catalog
 */

import { createHash } from 'node:crypto'

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { escapeText, isModelInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'

/** Runtime name of the loader this plugin replaces. */
const SKILL_TOOL = 'skill'

/** Upstream's catalog kind; its messages are stale wherever the loader is denied. */
// Typed `string`: the kind comes from a producer this build's `MessageSourceMap`
// does not declare, so the declared union alone would reject the comparison.
const UPSTREAM_KIND: string = 'skill-catalog'

/** This plugin's catalog kind. */
const CATALOG_KIND = 'omd-skill-catalog'

/** Upstream's default description cap, kept as this plugin's default. */
const DEFAULT_DESCRIPTION_MAX_LENGTH = 500

/** The projection key this package owns. */
const KEY = 'omdSkillCatalog'

/** One published catalog line, durable beside the rendered prose. */
interface CatalogEntry {
  readonly name: string
  readonly description: string
}

/** Producer-declared source of one catalog message. */
export interface SkillCatalogSource {
  readonly kind: 'omd-skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly CatalogEntry[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'omd-skill-catalog': SkillCatalogSource
  }
}

/** What this session already published, folded from its own log. */
export interface CatalogState {
  /** Digest of the entries last published; absent before the first publication. */
  digest?: string
  /** Seq of the newest catalog message, for the surface check. */
  seq?: number
  /** The log carries an upstream `skill-catalog` message from before this plugin. */
  upstream?: true
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Publication state of the session skill catalog, host-only. */
    omdSkillCatalog: CatalogState
  }
}

/** Plugin id the Loader entry carries. */
export const name = 'omd-skill-catalog'

/** Services this plugin needs before its fiber activates. */
export const inject = ['skills', 'workingDirectory', 'sessionProjections']

/** Deployment settings for the catalog. */
export interface Config {
  /** Publish the catalog and deny the upstream loader. False leaves skills entirely upstream. */
  enabled: boolean
  /** Maximum normalized description length rendered per skill; minimum 3. */
  descriptionMaxLength: Volatile<number>
}

/** Schemastery configuration for the catalog. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true)
    .description('Deny the `skill` tool and publish the catalog here; false leaves both to upstream `dsh-tool-skill`.'),
  descriptionMaxLength: z.number().step(1).min(3).default(DEFAULT_DESCRIPTION_MAX_LENGTH)
    .volatile()
    .description('Maximum normalized description length rendered per skill.'),
})

/** The revision a session that never published a catalog reads; nobody mutates it. */
const EMPTY: CatalogState = {}

/** Host fold schema; what the projection cache persists. */
const stateSchema: ZodType<CatalogState> = zod.object({
  digest: zod.string().optional(),
  seq: zod.number().int().nonnegative().optional(),
  upstream: zod.literal(true).optional(),
})

/**
 * Entries of one catalog source, or undefined when the record is not readable.
 *
 * A resumed, forked, or externally written log can carry a catalog record this
 * build never wrote; an unreadable record is treated as "not a catalog" rather
 * than throwing inside a pre-step listener, which would fail every later turn
 * of that session.
 * @param source - the message source to read.
 * @returns the entries, or undefined.
 */
function readEntries(source: unknown): CatalogEntry[] | undefined {
  if (typeof source !== 'object' || source === null || !('entries' in source)) return undefined
  const entries = source.entries
  if (!Array.isArray(entries)) return undefined
  const readable: CatalogEntry[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || !('description' in entry)) return undefined
    const { name, description } = entry
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    readable.push({ name, description })
  }
  return readable
}

/**
 * Catalog identity over the durable entry list rather than the rendered prose.
 * The entries are what changes; the surrounding framing is written for the
 * model and must not decide whether a republish is needed.
 * @param entries - the entries a message publishes.
 * @returns a stable digest.
 */
function digestEntries(entries: readonly CatalogEntry[]): string {
  const canonical = entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * One description as the catalog renders it: whitespace-normalized and capped.
 * @param value - the provider's description.
 * @param maxLength - the configured cap.
 * @returns the rendered description.
 */
function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

/**
 * Entries for the skills a model may invoke, in registry order.
 * @param skills - one complete snapshot.
 * @param maxLength - the configured description cap.
 * @returns the catalog entries.
 */
function catalogEntries(skills: readonly SkillSummary[], maxLength: number): CatalogEntry[] {
  return skills.filter(isModelInvocable).map(skill => ({
    name: skill.name,
    description: catalogDescription(skill.description, maxLength),
  }))
}

/**
 * The model-facing catalog message.
 * @param entries - what this message publishes.
 * @param replacement - whether earlier lists exist in the log.
 * @returns the user message to inject.
 */
function renderCatalog(entries: readonly CatalogEntry[], replacement: boolean): UserMessage {
  const head = replacement
    ? 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:'
    : 'A skill is a reusable set of task-specific instructions. The following skills are available in this session:'
  const guidance = entries.length === 0
    ? [
      'No skills are currently available. Do not use names from earlier skill catalogs.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it.',
    ]
    : [
      "If the user names a skill, or the task clearly matches a skill's description, read it with `read skill://<name>` "
      + 'before taking task actions. Load all applicable skills, then follow their full instructions. This catalog '
      + "contains summaries only; do not infer or follow a skill's instructions until it has been read.",
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. '
      + 'Follow it, and do not read that skill again.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        head,
        '',
        '<available_skills>',
        ...entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`),
        '</available_skills>',
        '',
        ...guidance,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: CATALOG_KIND,
      form: 'catalog',
      ...replacement ? { update: true as const } : {},
      entries,
    },
  })
}

/**
 * Deny the upstream loader on every agent that inherited it, and publish the
 * catalog for exactly the agents where the deny took.
 * @param ctx - the entry fiber's context.
 * @param config - whether the plugin runs and the description cap.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  /** Agents whose `skill` tool this plugin removed; only they get its catalog. */
  const governed = new Set<string>()

  ctx.sessionProjections.register({
    key: KEY,
    stateVersion: 1,
    stateSchema,
    init: () => EMPTY,
    apply(state, event) {
      if (event.type !== 'user/message') return state
      const source = event.data.source
      if (source.kind === UPSTREAM_KIND) return state.upstream === true ? state : { ...state, upstream: true }
      if (source.kind !== CATALOG_KIND) return state
      const entries = readEntries(source)
      if (entries === undefined) return state
      const next: CatalogState = { digest: digestEntries(entries), seq: Number(event.seq) }
      return state.upstream === true ? { ...next, upstream: true } : next
    },
  })

  // An agent preset registers its own `skill` row in a scope nearer the agent
  // than this plugin's, so the deny belongs on the agent's own context: it
  // masks the inherited name for that agent alone and unwinds with it.
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => () => {
      governed.delete(String(agent.id))
    })
    // `get`, not `agent.ctx.tools`: property access demands an `inject` this
    // plugin's context does not carry for another context's service.
    const tools = agent.ctx.get('tools')
    if (tools === undefined) return
    if (!tools.schemas(agent).some(definition => definition.name === SKILL_TOOL)) return
    try {
      tools.restrict({ deny: [SKILL_TOOL] })
    } catch (error: unknown) {
      ctx.logger.warn('omd-skill-catalog: could not deny the `skill` tool, leaving the upstream catalog in place: %o', error)
      return
    }
    if (tools.get(SKILL_TOOL, agent) !== undefined) {
      // A registration in the agent's own scope is outside its own allow/deny
      // mask; upstream's catalog still matches that visible tool, so it wins.
      ctx.logger.warn('omd-skill-catalog: the `skill` tool stayed visible after the deny, leaving the upstream catalog in place')
      return
    }
    governed.add(String(agent.id))
  })

  // Prepended: every listener's contribution is behind this one on the way
  // back, so the stale-kind filter below sees the final message list.
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // Nothing is behind us: upstream's own catalog is the one in force.
    if (!governed.has(String(agent.id))) return decision

    const withoutUpstream = decision.messages.filter(message => message.source.kind !== UPSTREAM_KIND)
    const existing = withoutUpstream.find(message => message.source.kind === CATALOG_KIND)
    const state = ctx.sessionProjections.stateOf(agent.session, KEY) ?? EMPTY
    const catalog = {
      ...decision,
      messages: withoutUpstream.length === decision.messages.length ? decision.messages : withoutUpstream,
    }

    const lookup = { cwd: await ctx.workingDirectory.ensure(agent, signal), signal, scope: agent }
    const snapshot = await ctx.skills.snapshot(lookup)
    signal.throwIfAborted()
    // An incomplete snapshot would replace a good catalog with a partial one.
    if (!snapshot.complete) return catalog

    const entries = catalogEntries(snapshot.skills, config.descriptionMaxLength.get())
    const digest = digestEntries(entries)
    const visible = state.seq !== undefined
      && agent.session.surface.nodes.some(seq => Number(seq) === state.seq)

    if (state.digest === digest && visible) {
      if (existing === undefined) return catalog
      // The log already carries exactly this catalog; a second copy would only
      // repeat the list.
      return { ...catalog, messages: catalog.messages.filter(message => message.id !== existing.id) }
    }
    // Nothing was ever published and there is nothing to publish: upstream's
    // rule for a skill-less session.
    if (state.digest === undefined && entries.length === 0) return catalog

    const message = renderCatalog(entries, state.digest !== undefined || state.upstream === true)
    return {
      ...catalog,
      messages: existing === undefined
        ? [...catalog.messages, message]
        : catalog.messages.map(candidate => candidate.id === existing.id ? message : candidate),
    }
  }, { prepend: true })
}
