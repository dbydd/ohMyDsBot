/**
 * The judge half of the assembler: one batched judgment call over every
 * suspended candidate, plus the conservative fallback for when no judge is
 * mounted.
 *
 * The judge is a reasoning peer, not a rule engine: the state explains the
 * situation (which turn material was seen, which keys fired, what each
 * SillyTavern logic means, which entries share a group) instead of listing
 * bare labels. Every settled choice is returned with its confidence so the
 * caller can log one auditable line per entry.
 *
 * @module omd-tavern-assemble/decide
 */

import type { LoreEntry } from 'omd-context-tavern/document'
import type { ChoiceQuestion, JudgmentRequest, JudgmentResult } from 'omd-judgment/types'
import { conservativeSecondary } from './select.ts'

/** The face of `ctx.judgment` this consumer reads; the service is optional. */
export interface JudgeFace {
  /** Whether a candidate is credentialed and not cooling down. */
  available(): boolean
  /** Answer one request through the candidate chain. */
  judge(request: JudgmentRequest, options?: { signal?: AbortSignal }): Promise<JudgmentResult>
}

/** How one suspended entry was settled this turn. */
export interface Decision {
  /** `include` puts the entry in the prefix; `exclude` leaves it out. */
  readonly choice: 'include' | 'exclude'
  /** The judge's confidence in `choice`; 0 for the conservative rule. */
  readonly confidence: number
  /** Which path produced the decision. */
  readonly source: 'judge' | 'judge-fallback' | 'low-confidence' | 'invalid-answer' | 'rule'
}

/** Everything one batched decision needs. */
export interface DecideInput {
  /** Suspended candidates awaiting a decision. */
  readonly judged: readonly LoreEntry[]
  /** The turn material the keys were matched against. */
  readonly material: string
  /** The optional judgment service. */
  readonly judge: JudgeFace | undefined
  /** Judge answers below this confidence are treated as exclude. */
  readonly confidenceFloor: number
  /** Abort signal for the judge call. */
  readonly signal?: AbortSignal
}

/** Longest single recent-message excerpt the judge state keeps. */
const MESSAGE_CHARS = 600

/** Clip one excerpt and mark the cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** SillyTavern logic labels for the judge state. */
const LOGIC_LABELS: Readonly<Record<number, string>> = {
  0: 'AND_ANY（主键命中且任一次键命中才注入）',
  1: 'NOT_ALL（主键命中且并非全部次键命中才注入）',
  2: 'NOT_ANY（主键命中且没有任何次键命中才注入）',
  3: 'AND_ALL（主键命中且全部次键命中才注入）',
}

/** The per-entry facts the judge sees, in state. */
function entryView(entry: LoreEntry, material: string): Record<string, string | number | readonly string[] | boolean> {
  const secondary = entry.meta?.secondaryKeys ?? []
  const logic = entry.meta?.selectiveLogic ?? 0
  return {
    id: entry.id,
    name: entry.name,
    primaryKeys: entry.keys,
    secondaryKeys: secondary,
    selectiveLogic: LOGIC_LABELS[logic] ?? `unknown(${String(logic)})`,
    secondaryKeysPresentInConversation: secondary.filter(key => key !== '' && material.includes(key)),
    ...(entry.meta?.group === undefined || entry.meta.group === ''
      ? {}
      : { group: entry.meta.group }),
  }
}

/** The shared instruction one choice question carries. */
function questionInstructions(entry: LoreEntry): string {
  return [
    `世界书条目「${entry.name}」的触发键命中了最近的用户消息。`,
    'include 表示把这条条目注入本轮模型上下文，为对话提供背景设定；',
    'exclude 表示本轮不注入，避免无关条目稀释上下文。',
    '请综合条目的键、 selectiveLogic 语义、最近对话以及分组关系判断：这条设定是否与本轮对话真正相关。',
  ].join(' ')
}

/** Build one batched judgment request over the suspended candidates. */
export function buildJudgeRequest(judged: readonly LoreEntry[], material: string): JudgmentRequest {
  const questions: Record<string, ChoiceQuestion> = {}
  for (const entry of judged) {
    questions[entry.id] = {
      type: 'choice',
      instructions: questionInstructions(entry),
      criteria: {
        include: '本轮对话与这条设定相关，注入它能提供有用的背景',
        exclude: '本轮对话与这条设定关系不大，注入只会占用上下文',
      },
    }
  }
  const summary = material.split('\n').map(line => clip(line, MESSAGE_CHARS))
  const state = {
    situation: '角色扮演上下文装配器正在决定：本轮该把哪些世界书条目送进模型请求的前缀。',
    groups: [
      ...new Set(judged.map(entry => entry.meta?.group).filter((group): group is string => group !== undefined && group !== '')),
    ].map(group => ({
      group,
      members: judged.filter(entry => entry.meta?.group === group).map(entry => entry.name),
      note: '同组条目互斥：最终只会注入其中一条。',
    })),
    entries: judged.map(entry => entryView(entry, material)),
    recentConversation: summary,
    note: '条目正文不在此处：判定只依据名称、键、逻辑语义与最近对话。',
  }
  return { state, questions }
}

/**
 * Decide every suspended entry in one judge round trip. When the judge is
 * absent, unavailable, or fails, the conservative rule in
 * {@link conservativeSecondary} decides instead — the caller still gets a
 * complete decision map, never a throw.
 * @param input - candidates, material, judgment face, confidence floor.
 * @returns one decision per candidate id.
 */
export async function decideEntries(input: DecideInput): Promise<ReadonlyMap<string, Decision>> {
  const decisions = new Map<string, Decision>()
  const ruleAll = (source: Decision['source']): void => {
    for (const entry of input.judged) {
      decisions.set(entry.id, {
        choice: conservativeSecondary(entry, input.material) ? 'include' : 'exclude',
        confidence: 0,
        source,
      })
    }
  }
  if (input.judge === undefined || !input.judge.available()) {
    ruleAll('rule')
    return decisions
  }
  let result: JudgmentResult
  try {
    result = await input.judge.judge(
      buildJudgeRequest(input.judged, input.material),
      input.signal === undefined ? undefined : { signal: input.signal },
    )
  } catch {
    ruleAll('judge-fallback')
    return decisions
  }
  for (const entry of input.judged) {
    const answer = result.answers[entry.id]
    if (answer === undefined || answer.type !== 'choice'
      || (answer.choice !== 'include' && answer.choice !== 'exclude')) {
      decisions.set(entry.id, { choice: 'exclude', confidence: 0, source: 'invalid-answer' })
      continue
    }
    if (answer.choice === 'include' && answer.confidence < input.confidenceFloor) {
      decisions.set(entry.id, { choice: 'exclude', confidence: answer.confidence, source: 'low-confidence' })
      continue
    }
    decisions.set(entry.id, { choice: answer.choice, confidence: answer.confidence, source: 'judge' })
  }
  return decisions
}
