/**
 * The budgeted context every judge call is assembled from.
 *
 * Priority is fixed: the constant task statement lives outside the state, then
 * the active todo tree, the last human message, the three newest assistant
 * messages, and finally the tool history. Section 5 (tool history) is trimmed
 * first, then 4, then 3; the todo tree is cut last. The state never carries the
 * system prompt, tool schemas, spill bodies, or image bytes.
 *
 * @module omd-judge-context/assemble
 */

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  JudgeContext,
  JudgeContextState,
  JudgeFacts,
  JudgePurpose,
  JudgeTodoNode,
  JudgeToolCall,
} from './types.ts'

/** Constant task text for a todo-continuation verdict. */
export const TODO_CONTINUATION_TASK = [
  '你是待办续跑判官：判断模型在回合停止点是否应继续推进当前待办。',
  '判定顺序：只要 todo 里还有 state=active 的条目，且 waiting 里没有会自己回来的事件'
  + '（running/stopping 的后台作业、running 的子代理、未回答的用户提问），就选 continue。',
  '只有 todo 里没有 active 条目，或 waiting 明确非空，或下一步必须由用户先决定时，才选 wait/done。',
  '模型自己的“已完成”“已停下”说法不是证据，以 todo 的 state 为准；'
  + '只依据 state，state 没有写出的等待不要推测，拿不准时选 wait。',
].join('\n')

/**
 * Built-in task text per purpose. A purpose without an entry is a caller error
 * unless the caller supplies `task`: inventing a second judge contract here is
 * how two lines drift apart.
 */
export const DEFAULT_TASKS: Readonly<Partial<Record<JudgePurpose, string>>> = {
  'todo-continuation': TODO_CONTINUATION_TASK,
}

/** Longest last-user text the state keeps before later trimming. */
const LAST_USER_CHARS = 800
/** Longest single assistant message the state keeps. */
const ASSISTANT_CHARS = 600
/** Longest argument or result excerpt one tool call contributes. */
const CALL_CHARS = 160
/** The todo tree cap the recipe names before any budget trimming. */
const TODO_CAP = 30

/** One tool call plus the result that answered it, if any. */
interface RawCall {
  callId: string
  name: string
  arguments: string
}

/** One result keyed by the call it answers. */
interface RawResult {
  isError: boolean
  text: string
}

/** One transformation applied when the fixed sections do not fit the budget. */
interface Stage {
  assistants: readonly string[]
  user: string | undefined
  todoCap: number
  includeTodo: boolean
  keepExplanation: boolean
  goalChars: number
}

/** Read one property off an untrusted object. */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

/** Read an untrusted object, or nothing. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Join the visible text blocks of one message content array. */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (field(block, 'type') !== 'text') continue
    const text = field(block, 'text')
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/** Trim to at most `max` code points, marking the cut. */
function clip(text: string, max: number): string {
  const points = [...text]
  return points.length <= max ? text : `${points.slice(0, max).join('')}…`
}

/** Collapse whitespace so one call occupies one line. */
function compact(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** The first non-empty line of a result body. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** Count a todo node and every descendant. */
function countNodes(node: JudgeTodoNode): number {
  let total = 1
  for (const child of node.children ?? []) total += countNodes(child)
  return total
}

/** Copy and bound one todo tree, reporting how many nodes the cap dropped. */
function capTodo(
  nodes: readonly JudgeTodoNode[],
  stage: Stage,
): { nodes: JudgeTodoNode[]; omitted: number } {
  let kept = 0
  let omitted = 0
  const walk = (list: readonly JudgeTodoNode[]): JudgeTodoNode[] => {
    const out: JudgeTodoNode[] = []
    for (const node of list) {
      if (kept >= stage.todoCap) {
        omitted += countNodes(node)
        continue
      }
      kept += 1
      const next: JudgeTodoNode = { path: node.path, content: node.content, state: node.state }
      if (node.goal !== undefined && node.goal !== '') {
        next.goal = stage.goalChars > 0 ? clip(node.goal, stage.goalChars) : node.goal
      }
      if (stage.keepExplanation && node.explanation !== undefined && node.explanation !== '') {
        next.explanation = node.explanation
      }
      if (node.children !== undefined && node.children.length > 0) {
        const children = walk(node.children)
        if (children.length > 0) next.children = children
      }
      out.push(next)
    }
    return out
  }
  return { nodes: walk(nodes), omitted }
}

/** The last human message, clipped to the recipe's ceiling. */
function lastUserMessage(events: readonly SessionEvent[]): string | undefined {
  let found: string | undefined
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = recordOf(field(event.data, 'source'))
    if (field(source, 'kind') !== 'user') continue
    const text = textOfContent(field(event.data, 'content')).trim()
    if (text !== '') found = clip(text, LAST_USER_CHARS)
  }
  return found
}

/** The three newest assistant messages with visible text, oldest first. */
function assistantMessages(events: readonly SessionEvent[]): string[] {
  const found: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const message = recordOf(field(event.data, 'message'))
    const text = textOfContent(field(message, 'content')).trim()
    if (text === '') continue
    const interrupted = field(event.data, 'interrupted') === true
    found.push(clip(interrupted ? `${text}\n[interrupted]` : text, ASSISTANT_CHARS))
  }
  return found.slice(-3)
}

/** Every tool call in log order, with results keyed by call id. */
function collectCalls(events: readonly SessionEvent[]): {
  calls: RawCall[]
  results: Map<string, RawResult>
} {
  const calls: RawCall[] = []
  const results = new Map<string, RawResult>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const callId = field(event.data, 'callId')
      const name = field(event.data, 'name')
      const args = field(event.data, 'arguments')
      if (typeof callId !== 'string' || typeof name !== 'string') continue
      calls.push({
        callId,
        name,
        arguments: typeof args === 'string' ? args : '',
      })
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = recordOf(field(event.data, 'message'))
    const callId = field(message, 'toolCallId')
    if (typeof callId !== 'string') continue
    results.set(callId, {
      isError: field(message, 'isError') === true,
      text: textOfContent(field(message, 'content')),
    })
  }
  return { calls, results }
}

/** Render one call for the judge. */
function renderCall(call: RawCall, result: RawResult | undefined): JudgeToolCall {
  const record: JudgeToolCall = {
    state: result === undefined ? 'unfinished' : result.isError ? 'error' : 'ok',
    name: call.name,
    arguments: clip(compact(call.arguments), CALL_CHARS),
  }
  if (result !== undefined) {
    const line = firstLine(result.text)
    if (line !== '') record.result = clip(compact(line), CALL_CHARS)
  }
  return record
}

/** Approximate token count: ASCII at four characters per token, everything else one per code point. */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const point of text) {
    if ((point.codePointAt(0) ?? 0) <= 0x7f) ascii += 1
    else other += 1
  }
  return Math.ceil(ascii / 4 + other)
}

/** The fixed sections for one trimming stage, before tool history. */
function baseWithoutTools(input: {
  purpose: JudgePurpose
  facts: JudgeFacts | undefined
  assistants: readonly string[]
  user: string | undefined
  stage: Stage
}): JudgeContextState {
  const state: JudgeContextState = {
    assistant_messages: input.stage.assistants,
    tool_calls: [],
    omitted_tool_calls: 0,
  }
  const waiting = input.facts?.waiting
  if (waiting !== undefined) {
    const compactWaiting: NonNullable<JudgeContextState['waiting']> = {}
    if (waiting.jobs !== undefined) compactWaiting.jobs = waiting.jobs
    if (waiting.children !== undefined) compactWaiting.children = waiting.children
    if (waiting.user_questions !== undefined) compactWaiting.user_questions = waiting.user_questions
    state.waiting = compactWaiting
  }
  if (input.user !== undefined && input.user !== '') state.last_user_message = input.user
  if (input.stage.includeTodo && input.facts?.todos !== undefined) {
    const capped = capTodo(input.facts.todos, input.stage)
    if (capped.nodes.length > 0) state.todo = capped.nodes
    if (capped.omitted > 0) state.todo_omitted = capped.omitted
  }
  return state
}

/** The trimming ladder: tool history first, then assistants, then the user, then todo. */
function stages(
  assistants: readonly string[],
  user: string | undefined,
): Stage[] {
  const ladder: Stage[] = []
  const base = { todoCap: TODO_CAP, includeTodo: true, keepExplanation: true, goalChars: 0 }
  ladder.push({ ...base, assistants, user })
  ladder.push({ ...base, assistants: [], user })
  ladder.push({ ...base, assistants: [], user: user === undefined ? undefined : clip(user, 400) })
  ladder.push({ ...base, assistants: [], user: undefined })
  ladder.push({ ...base, assistants: [], user: undefined, todoCap: 10 })
  ladder.push({ ...base, assistants: [], user: undefined, todoCap: 5, keepExplanation: false })
  ladder.push({
    ...base, assistants: [], user: undefined, todoCap: 1, keepExplanation: false, goalChars: 80,
  })
  ladder.push({ ...base, assistants: [], user: undefined, todoCap: 0, includeTodo: false })
  return ladder
}

/**
 * Assemble one judge context from an already-read session log.
 *
 * Pure: no service reads, no clock, no mutation of the inputs. `budget` bounds
 * the serialized state; the constant task is not part of it.
 * @param input - header, events, budget, purpose, task override, and caller facts.
 * @returns the task text plus the budgeted state and its measured size.
 * @throws when the purpose has no built-in task and the caller supplied none.
 */
export function assembleJudgeContext(input: {
  header: SessionHeader
  events: readonly SessionEvent[]
  budget: number
  purpose: JudgePurpose
  task?: string
  facts?: JudgeFacts
}): JudgeContext {
  const task = input.task ?? DEFAULT_TASKS[input.purpose]
  if (task === undefined) {
    throw new Error(
      `omd-judge-context: purpose "${input.purpose}" has no built-in task; pass one explicitly`,
    )
  }
  const budget = Math.max(0, Math.floor(input.budget))
  const user = lastUserMessage(input.events)
  const assistants = assistantMessages(input.events)
  const { calls, results } = collectCalls(input.events)

  let state: JudgeContextState | undefined
  for (const stage of stages(assistants, user)) {
    const candidate = baseWithoutTools({
      purpose: input.purpose, facts: input.facts, assistants, user, stage,
    })
    if (estimateTokens(JSON.stringify(candidate)) <= budget) {
      state = candidate
      break
    }
  }
  if (state === undefined) {
    const last = stages(assistants, user).at(-1)!
    state = baseWithoutTools({
      purpose: input.purpose, facts: input.facts, assistants, user, stage: last,
    })
  }

  const rendered = calls.map(call => renderCall(call, results.get(call.callId)))
  const abnormal = rendered
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.state !== 'ok')
    .reverse()
  const normal = rendered
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.state === 'ok')
    .reverse()
  const ordered = [...abnormal, ...normal].map(({ record }) => record)

  const used = estimateTokens(JSON.stringify(state))
  let remaining = budget - used
  const included: JudgeToolCall[] = []
  let omitted = 0
  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index]!
    const cost = estimateTokens(JSON.stringify(record)) + 1
    if (cost > remaining) {
      omitted = ordered.length - index
      break
    }
    included.push(record)
    remaining -= cost
  }

  if (included.length > 0) state.tool_calls = included
  state.omitted_tool_calls = omitted
  if (omitted > 0) {
    state.notes = [
      budget <= used
        ? `预算不足，全部 ${omitted} 条调用已省略`
        : `更早的 ${omitted} 条调用已省略`,
    ]
  }

  return {
    purpose: input.purpose,
    task,
    state,
    tokens: estimateTokens(JSON.stringify(state)),
  }
}
