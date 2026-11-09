/**
 * omd-auto-thinking — picks a reasoning effort per step from the user request.
 *
 * @module omd-auto-thinking
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import z from '@deepseek-ai/schemastery'

import type { JudgmentService, ScoreAnswer } from './types.ts'

export const name = 'omd-auto-thinking'

export const inject = ['judgment']

export interface Config {
  /** Select a reasoning effort per step. False registers nothing. */
  enabled: boolean
  /** Effort ids for [simple, medium, complex], in ascending order. */
  efforts: string[]
  /** Longest user text, in characters, sent to the judge. */
  maxPromptChars: Volatile<number>
  /** Judge confidence at or above which the scored effort is applied. */
  minConfidence: Volatile<number>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('Enable automatic reasoning-effort selection.'),
  efforts: z.array(z.string()).default(['low', 'medium', 'high']).description('Effort ids for [simple, medium, complex].'),
  maxPromptChars: z.number().step(1).min(1).default(4000)
    .volatile()
    .description('Max user-text chars sent to the judge.'),
  minConfidence: z.number().min(0).max(1).default(0.6)
    .volatile()
    .description('Judge confidence at or above which the scored effort is applied.'),
})

const CRITERIA = ['Simple lookup, rename, or formatting', 'Multi-file change with local reasoning', 'Cross-cutting design, debugging, or migration'] as const

const perAgentText = new Map<string, string>()

function lastUserText(messages: readonly { content: readonly { type: string; text?: string }[] }[]): string {
  const last = messages.at(-1)
  if (last === undefined) return ''
  return last.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (config.efforts.length !== 3) {
    throw new Error('omd-auto-thinking: `efforts` must contain exactly 3 entries')
  }

  // Track per-agent text; clean up on disposal.
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => () => {
      perAgentText.delete(agent.id)
    })
  })

  // Record the last user message text for this step.
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const text = lastUserText(messages as never).slice(0, config.maxPromptChars.get())
    if (text !== '') {
      perAgentText.set(agent.id, text)
    } else {
      perAgentText.delete(agent.id)
    }
    return next()
  })

  // Rewrite reasoningEffort based on the judge's score.
  ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const text = perAgentText.get(payload.agent.id)
    if (text === undefined || text === '') return resolved
    let judgment: JudgmentService | undefined
    try {
      judgment = (ctx as unknown as { get?: (key: string) => unknown }).get?.('judgment') as JudgmentService | undefined
      if (judgment === undefined) judgment = (ctx as unknown as { judgment?: JudgmentService }).judgment
    } catch {
      judgment = undefined
    }
    if (judgment === undefined || !judgment.available()) return resolved
    try {
      const result = await judgment.judge({
        state: text,
        questions: {
          effort: {
            type: 'score',
            instructions: 'Classify the difficulty of the user request.',
            criteria: [...CRITERIA],
          },
        },
      })
      const answer = result.answers.effort as ScoreAnswer
      const score = answer.score
      const confidence = answer.confidence
      const effort = config.efforts[score]
      if (typeof effort === 'string' && confidence >= config.minConfidence.get() && config.efforts.includes(effort)) {
        return { ...resolved, reasoningEffort: ReasoningEffortId(effort) }
      }
      return resolved
    } catch {
      return resolved
    }
  })
}
