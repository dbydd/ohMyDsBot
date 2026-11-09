/**
 * `omd-visual` — an answer gets a rendered component without the answering
 * agent ever holding a UI tool.
 *
 * The delivery is a **fenced block in a child's text**, not a tool call. That
 * choice is what keeps the parent's prefix intact: the child is spawned with
 * `provider: 'spawn'` and no `agentPreset`, so it joins the parent's current
 * generation and receives the parent's system prompt and tool array byte for
 * byte; the fence contract travels as the child's one user message, where it
 * cannot touch either. `delivery: 'caller'` keeps the settlement out of the
 * parent's model history, and the fence itself is stored in an `ignorable`
 * `plugin:omd/visual` record, so the parent never reads what it did not ask for.
 *
 * The host still mounts the UI plugin (motion-ui) globally, because browser
 * bundles are discovered from host Loader entries only. With `maskHostTools`
 * on, its fifteen tools are masked for every agent through `agent.ctx` and its
 * three prompt sections are shadowed with empty text in the same scope: a tool
 * the model can see but the child must not use would either be called or poison
 * the prefix. With the switch off, the answering agent draws directly and this
 * package only keeps its delegation path.
 *
 * The only trigger is an explicit request in the newest user message: asking
 * for a picture is the human's decision, so a manual command would only repeat
 * it. Judge-gated automatic triggering needs the shared judge-context package
 * (`plugins/omd-judge-context/`) and is not wired here.
 *
 * @module omd-visual
 */

import { readFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

import { extractFence, fenceLabels, saysNoVisual } from './fence.ts'
import { asksForVisual } from './precheck.ts'
import { writeVisualRecord, type VisualRecordInput } from './record.ts'
import { registerVisualSource } from './resource.ts'
import type {
  PromptFace, SubagentActivation, SubagentFace, ToolFace, VisualDecision,
} from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-visual'

/** The subagent seam is the only service the delivery cannot work without. */
export const inject = ['subagents']

/**
 * The visual plugin's model-facing tools.
 *
 * Every one is denied for every agent: the worker is told to use none of them,
 * and the parent must not spend a decision on them. The list is duplicated from
 * the host plugin on purpose — this package does not import a third-party
 * package to learn its tool names, and an upgrade that renames one simply stops
 * masking it, which the prefix comparison in the README catches.
 */
const HOST_UI_TOOLS: readonly string[] = [
  'render_text', 'render_ui', 'render_canvas', 'render_scene', 'render_mechanism',
  'ui_catalog', 'validate_ui', 'inspect_ui', 'patch_ui', 'update_ui',
  'preview_video', 'synthesize_voice', 'render_video', 'inspect_video', 'process_video',
]

/**
 * The host plugin's system-prompt sections, shadowed with empty text.
 *
 * `restrict` removes schemas only; the guidance that teaches those tools would
 * survive it and leave the model looking for tools that are not there. A scoped
 * section of the same name replaces the global one, and an empty section is
 * dropped at render time.
 */
const HOST_SECTIONS: readonly { name: string; order: number }[] = [
  { name: 'generative-ui:design-skill', order: 850 },
  { name: 'generative-ui:protocol', order: 851 },
  { name: 'generative-ui:worked-examples', order: 852 },
]

/** Deployment settings. */
export interface Config {
  /**
   * `explicit` spawns a worker only when the newest human message asks for a
   * picture. `off` registers nothing; existing records stay readable through
   * their addresses.
   */
  mode: 'explicit' | 'off'
  /**
   * Hide the host UI plugin's tools and prompt sections from every agent, so
   * only a visual worker can produce a picture. `false` leaves them visible and
   * lets the answering agent draw directly.
   */
  maskHostTools: boolean
  /** Longest excerpt of the user's question quoted in the brief. */
  maxQuestionChars: number
  /** Longest excerpt of the answer quoted in the brief. */
  maxMaterialChars: number
  /** Deadline for one worker, from admission through its final text. */
  timeoutMs: number
}

/** Every field carries a default so an empty patch row still works. */
export const Config: z<Config> = z.object({
  mode: z.union(['explicit', 'off']).default('explicit').description(
    'explicit: delegate only when the newest human message asks for a picture. off: register nothing.',
  ),
  maskHostTools: z.boolean().default(true).description(
    'Hide the host UI tools and their prompt sections from every agent, leaving them to the visual worker. false lets the answering agent draw directly.',
  ),
  maxQuestionChars: z.number().step(1).min(1).default(4000).description(
    'Longest excerpt of the human question quoted in the worker brief, in characters.',
  ),
  maxMaterialChars: z.number().step(1).min(1).default(12000).description(
    'Longest excerpt of the answer handed to the worker, in characters.',
  ),
  timeoutMs: z.number().step(1).min(1000).default(120000).description(
    'Deadline for one worker run, in milliseconds. A run past it is aborted and its record says timeout.',
  ),
})

/** One in-flight worker, kept so disposal can abort it. */
interface Flight {
  readonly controller: AbortController
  activation?: SubagentActivation
}

/** What one turn offers the visualizer: the question and the settled answer. */
interface TurnMaterial {
  /** Newest human message in the turn. */
  readonly userText: string
  /** The turn's final answer text. */
  readonly answerText: string
  /** Log sequence of that answer, which becomes the card's address and anchor. */
  readonly answerSeq: number
  readonly answerStep: number
  readonly turn: number
}

/** Concatenated text blocks of one message, or `''`. */
function textOf(message: { readonly content?: readonly unknown[] } | undefined): string {
  if (message === undefined || !Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string') parts.push(text)
  }
  return parts.join('\n').trim()
}

/**
 * Read the question and the settled answer of one turn off the log.
 * @param session - the agent's session.
 * @param turn - the turn about to close.
 * @returns the material, or undefined when the turn has no answer or no human message.
 */
function readTurnMaterial(session: Session, turn: number): TurnMaterial | undefined {
  const events = session.snapshotEvents()
  let startSeq = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data.turn === turn) {
      startSeq = event.seq
      break
    }
  }
  if (startSeq < 0) return undefined

  let userText: string | undefined
  let fallbackUserText: string | undefined
  let answer: { seq: number; step: number; text: string } | undefined
  for (const event of events) {
    if (event.seq <= startSeq) continue
    if (event.type === 'user/message') {
      // `user/message` data IS the message; only `assistant/message` nests it.
      const text = textOf(event.data)
      if (text === '') continue
      fallbackUserText = text
      if (event.data.source.kind === 'user') userText = text
    } else if (event.type === 'assistant/message' && event.data.turn === turn) {
      const text = textOf(event.data.message)
      if (text !== '') answer = { seq: event.seq, step: event.data.step, text }
    }
  }
  const question = userText ?? fallbackUserText
  if (question === undefined || answer === undefined) return undefined
  return { userText: question, answerText: answer.text, answerSeq: answer.seq, answerStep: answer.step, turn }
}

/** Clip one excerpt and mark it when it was cut. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`
}

/**
 * Build the child's single user message: the question, the answer, the contract,
 * and the rules that keep the child inside them.
 * @param material - the turn's question and answer.
 * @param contract - the fence contract shipped with this package.
 * @param config - excerpt bounds.
 * @returns the brief.
 */
function buildBrief(material: TurnMaterial, contract: string, config: Config): string {
  return [
    'You are a visualization worker. One settled answer is quoted below; turn facts it already states into one UI document.',
    '',
    '## The question that was asked',
    clip(material.userText, config.maxQuestionChars),
    '',
    '## The answer to visualize',
    clip(material.answerText, config.maxMaterialChars),
    '',
    '## Output contract',
    contract.trim(),
    '',
    '## Rules',
    '- You have no UI tools. Never call or name one; the fenced block is the entire delivery.',
    '- Reply with exactly one fenced block and nothing else.',
    '- Visualize only facts the answer states. Never invent a number, a source, or progress.',
    '- If a picture would add no structure the text does not already carry, reply exactly NO_VISUAL.',
  ].join('\n')
}

/**
 * Mount the trigger, the tool mask, and the address reader.
 * @param ctx - plugin context carrying the subagent service.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const contract = readFileSync(new URL('../contract.md', import.meta.url), 'utf8')
  const flights = new Set<Flight>()

  // The reader is independent of the trigger: records written before `mode` was
  // turned off stay addressable, and reading one costs no model call.
  registerVisualSource(ctx)

  /**
   * Append a record, or say why it could not be appended.
   *
   * A session can close while its worker is still running; the answer then has
   * nowhere to land, which is not an error worth surfacing.
   * @param session - live session.
   * @param input - record fields, minus the derived address.
   */
  const record = (
    session: Session,
    input: VisualRecordInput,
  ): void => {
    try {
      writeVisualRecord(session, input)
    } catch (error) {
      ctx.logger.warn('omd-visual: could not append the %s record: %o', input.status, error)
    }
  }

  /**
   * Start one worker and settle its record.
   *
   * `pending` is written only for a human-triggered attempt. An automatic
   * attempt that ends in NO_VISUAL must leave no trace at all, and a pending
   * card that then vanished would be exactly that trace.
   * @param agent - the agent whose answer is decorated.
   * @param material - question and answer.
   * @param decidedBy - who asked.
   * @param visible - whether the attempt was requested by a human.
   */
  const spawnVisual = async (
    agent: Agent,
    material: TurnMaterial,
    decidedBy: VisualDecision,
    visible: boolean,
  ): Promise<void> => {
    const session = agent.session
    const base = {
      targetSeq: material.answerSeq,
      turn: material.turn,
      step: material.answerStep,
      decidedBy,
    } as const
    if (visible) record(session, { ...base, status: 'pending', reason: 'the worker is running' })

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`omd-visual: the worker exceeded ${config.timeoutMs}ms`))
    }, config.timeoutMs)
    const flight: Flight = { controller }
    flights.add(flight)

    try {
      const subagents = ctx.get('subagents') as SubagentFace | undefined
      if (subagents === undefined) throw new Error('the subagent service is not mounted')
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: `visual:${material.turn}`,
        request: {
          parent: agent,
          prompt: [{ type: 'text', text: buildBrief(material, contract, config) }],
        },
        signal: controller.signal,
        delivery: 'caller',
      })
      flight.activation = activation
      const result = await activation.result
      const text = result.output
        .filter(block => block.type === 'text')
        .map(block => typeof block['text'] === 'string' ? block['text'] : '')
        .join('\n')

      const fence = extractFence(text)
      const child = { childSessionId: String(activation.childId), childMode: 'continuable' as const }
      if (fence !== undefined) {
        record(session, {
          ...base,
          status: 'ready',
          ...child,
          fence: fence.raw,
          ...fenceLabels(fence),
        })
        return
      }
      const declined = saysNoVisual(text)
      const reason = declined
        ? 'the worker judged that a picture would add no structure'
        : result.stopReason === 'completed'
          ? 'the worker returned no usable fenced block'
          : `the worker ended with ${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}`
      if (declined && !visible) return
      record(session, { ...base, status: declined ? 'skipped' : 'failed', reason, ...child })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const status = timedOut ? 'timeout' : 'failed'
      const reason = timedOut
        ? `the worker produced no fence within ${config.timeoutMs}ms`
        : `the worker could not run: ${detail}`
      record(session, { ...base, status, reason })
    } finally {
      clearTimeout(timer)
      flights.delete(flight)
    }
  }

  ctx.effect(() => () => {
    for (const flight of flights) {
      flight.controller.abort(new Error('omd-visual: the plugin is unloading'))
      flight.activation?.dispose().catch((error: unknown) => {
        ctx.logger.warn('omd-visual: could not dispose a worker: %o', error)
      })
    }
    flights.clear()
  })

  if (config.mode === 'off') return

  ctx.on('agent/created', ({ agent }) => {
    const id = String(agent.id)
    if (!config.maskHostTools) return
    const tools = agent.ctx.get('tools') as ToolFace | undefined
    if (tools === undefined) {
      ctx.logger.warn('omd-visual: agent %s has no tools service; the host UI tools stay visible to it', id)
    } else {
      try {
        // Deny only names that exist: `restrict` rejects an unknown name, and the
        // host plugin is a separate installation that may be absent or upgraded.
        const present = new Set(tools.schemas(agent).map(tool => tool.name))
        const deny = HOST_UI_TOOLS.filter(tool => present.has(tool))
        if (deny.length > 0) tools.restrict({ deny })
      } catch (error) {
        // An unmasked tool surface is a real defect, but agent creation must not
        // fail over a decoration: report it and leave the rest of the mount.
        ctx.logger.warn('omd-visual: could not mask the host UI tools on agent %s; they stay visible: %o', id, error)
      }
    }

    const prompt = agent.ctx.get('systemPrompt') as PromptFace | undefined
    if (prompt === undefined) {
      ctx.logger.warn('omd-visual: agent %s has no systemPrompt service; the host UI guidance stays in its prompt', id)
    } else {
      for (const section of HOST_SECTIONS) {
        try {
          prompt.section({ ...section, text: '', interpolate: false })
        } catch (error) {
          ctx.logger.warn('omd-visual: could not shadow prompt section %s on agent %s: %o', section.name, id, error)
        }
      }
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      // A worker session never visualizes its own work.
      if (agent.session.header.parentSession !== undefined) return
      const material = readTurnMaterial(agent.session, turn)
      if (material === undefined) return
      if (!asksForVisual(material.userText)) return
      // Fire and forget: the answer is settled, and a human who asked for a
      // picture must not pay the worker's latency at the turn boundary.
      void spawnVisual(agent, material, { role: 'user' }, true)
        .catch((error: unknown) => { ctx.logger.warn('omd-visual: the worker failed: %o', error) })
    } catch (error) {
      // This listener is on the turn boundary; a decoration must never be able
      // to fail a turn that already produced its answer.
      ctx.logger.warn('omd-visual: could not read the turn: %o', error)
    }
  })
}
