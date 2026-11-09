/**
 * Todo tree validation and the conversions between the three shapes the domain
 * uses: the model's nested arguments, the flat `todo/write` list the shipped
 * panel renders, and the narrative detail tree this plugin records.
 *
 * Validation lives here, not in the tool, so every writer — the model, a
 * kanban, a file sync — passes through the same rules. The tool only adds the
 * policy the deployment chooses (`requireDetail`, `allowParallelActive`).
 *
 * @module omd-todo/tree
 */

import type { FlatTodoItem, TodoDetail, TodoItem, TodoSource, TodoState, TodoWireStatus } from './types.ts'
import { field } from './fields.ts'

/** Every accepted state value. */
export const TODO_STATES: readonly TodoState[] = ['active', 'inactive', 'completed']

/** Domain state → the status an upstream `todo/write` entry carries. */
const WIRE_STATUS: Record<TodoState, TodoWireStatus> = {
  active: 'in_progress',
  inactive: 'pending',
  completed: 'completed',
}

/** The upstream status back to the domain state; the inverse of {@link WIRE_STATUS}. */
const STATE_OF_WIRE: Record<TodoWireStatus, TodoState> = {
  pending: 'inactive',
  in_progress: 'active',
  completed: 'completed',
}

/**
 * Map a domain state onto the wire status `todo/write` stores.
 * @param state - the entry's state.
 * @returns the upstream status.
 */
export function wireStatusOf(state: TodoState): TodoWireStatus {
  return WIRE_STATUS[state]
}

/**
 * Map a stored `todo/write` status back to the domain state.
 * @param status - the wire status.
 * @returns the entry's state.
 */
export function stateOfWireStatus(status: TodoWireStatus): TodoState {
  return STATE_OF_WIRE[status]
}

/**
 * Deepest allowed index: 0 is a root, 1 its child, 2 its grandchild. Three
 * levels in total — the same depth `dsh-resource://todo/<session>/1.2.3` can
 * address. Deeper trees would spend request context on indentation without
 * adding a distinct step.
 */
export const MAX_DEPTH = 2

/** Whole-tree item cap: the list is injected into every request. */
export const MAX_ITEMS = 200

/** Deployment policy applied while validating a replacement. */
export interface TreePolicy {
  /** Require a non-empty `explanation` and `goal` on every node. */
  readonly requireDetail: boolean
  /** Allow more than one node to be `active` at once. */
  readonly allowParallelActive: boolean
}

/** Running total shared by one parse, so the cap covers the whole tree. */
interface ParseCounter {
  total: number
}

/** What the two narrative fields are for, quoted in the rejection message. */
const FIELD_PURPOSE = {
  explanation: 'say why this step exists and what it is connected to',
  goal: 'say what is true once this step is done',
} as const

/**
 * Validate and normalize one model- or caller-supplied list.
 * @param raw - the untrusted value (tool arguments or a service caller's list).
 * @param policy - deployment choices to enforce.
 * @returns the canonical tree: trimmed content, every level checked.
 * @throws with the failing item's path and field in the message.
 */
export function parseTodoTree(raw: unknown, policy: TreePolicy): TodoItem[] {
  if (!Array.isArray(raw)) throw new Error('invalid todo list: `todos` must be an array of items')
  const counter: ParseCounter = { total: 0 }
  const siblings = new Set<string>()
  const items = raw.map((node, index) => parseNode(node, `todos[${index}]`, 0, policy, counter, siblings))
  assertSingleActive(items, policy)
  return items
}

/**
 * Validate one node and its subtree.
 * @param raw - the untrusted node.
 * @param path - its address in the argument tree, used in every error.
 * @param depth - 0 for a root.
 * @param policy - deployment choices to enforce.
 * @param counter - running whole-tree item count.
 * @param siblings - contents already seen under this parent.
 * @returns the canonical node.
 */
function parseNode(
  raw: unknown,
  path: string,
  depth: number,
  policy: TreePolicy,
  counter: ParseCounter,
  siblings: Set<string>,
): TodoItem {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid todo at ${path}: expected an object with content, state, explanation, and goal`)
  }
  counter.total += 1
  if (counter.total > MAX_ITEMS) {
    throw new Error(
      `invalid todo tree: more than ${MAX_ITEMS} items — the whole tree is part of every request, `
      + 'so a larger list would spend the context budget; split the work into rounds instead',
    )
  }

  const rawContent = field(raw, 'content')
  const content = typeof rawContent === 'string' ? rawContent.trim() : ''
  if (content === '') throw new Error(`invalid todo at ${path}: \`content\` must be a non-empty string`)
  const label = `${path} ${JSON.stringify(content)}`
  if (siblings.has(content)) throw new Error(`invalid todo at ${path}: duplicate content ${JSON.stringify(content)} among siblings`)
  siblings.add(content)

  const state = field(raw, 'state')
  if (typeof state !== 'string' || !(TODO_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `invalid todo at ${label}: \`state\` must be one of ${TODO_STATES.join(', ')} (got ${JSON.stringify(state)})`,
    )
  }

  const explanation = detailField(raw, 'explanation', label, policy.requireDetail)
  const goal = detailField(raw, 'goal', label, policy.requireDetail)
  const source = sourceField(raw, label)

  const childrenRaw = field(raw, 'children')
  let children: TodoItem[] | undefined
  if (childrenRaw !== undefined) {
    if (!Array.isArray(childrenRaw)) throw new Error(`invalid todo at ${label}: \`children\` must be an array`)
    if (childrenRaw.length > 0) {
      if (depth + 1 > MAX_DEPTH) {
        throw new Error(
          `invalid todo at ${label}: todos nest at most ${MAX_DEPTH + 1} levels (root, child, grandchild) — `
          + 'the tree is part of every request, so deeper nesting spends context without adding a distinct step',
        )
      }
      const branchSiblings = new Set<string>()
      children = childrenRaw.map((child, index) => parseNode(
        child,
        `${path}.children[${index}]`,
        depth + 1,
        policy,
        counter,
        branchSiblings,
      ))
    }
  }

  if (state === 'completed' && children !== undefined) {
    const openIndex = children.findIndex(child => child.state !== 'completed')
    if (openIndex >= 0) {
      const offender = children[openIndex]!
      throw new Error(
        `invalid todo at ${label}: a completed todo must have every child completed, `
        + `but ${path}.children[${openIndex}] ${JSON.stringify(offender.content)} is ${offender.state}`,
      )
    }
  }

  const node: TodoItem = { content, state: state as TodoState, explanation, goal }
  if (source !== undefined) node.source = source
  if (children !== undefined) node.children = children
  return node
}

/**
 * Read, trim, and enforce one narrative field.
 * @param record - the raw node.
 * @param key - `explanation` or `goal`.
 * @param label - the item path plus its content, for the error.
 * @param required - whether an empty value is a rejection.
 * @returns the trimmed value, empty when absent and not required.
 */
function detailField(record: object, key: 'explanation' | 'goal', label: string, required: boolean): string {
  const value = field(record, key)
  if (value === undefined || value === null) {
    if (required) throw new Error(`invalid todo at ${label}: \`${key}\` is required — ${FIELD_PURPOSE[key]}`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`invalid todo at ${label}: \`${key}\` must be a string`)
  const trimmed = value.trim()
  if (trimmed === '' && required) throw new Error(`invalid todo at ${label}: \`${key}\` is required — ${FIELD_PURPOSE[key]}`)
  return trimmed
}

/**
 * Read and validate tracker provenance.
 * @param record - the raw node.
 * @param label - the item path plus its content, for the error.
 * @returns the source, or undefined when absent.
 */
function sourceField(record: object, label: string): TodoSource | undefined {
  const value = field(record, 'source')
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid todo at ${label}: \`source\` must be an object like { kind: "issue", repo: "owner/name", number: 12 }`)
  }
  const kind = field(value, 'kind')
  if (kind !== 'issue' && kind !== 'manual') {
    throw new Error(`invalid todo at ${label}: \`source.kind\` must be "issue" or "manual"`)
  }
  const source: TodoSource = { kind }
  const repo = field(value, 'repo')
  if (repo !== undefined && repo !== null) {
    if (typeof repo !== 'string' || repo.trim() === '') {
      throw new Error(`invalid todo at ${label}: \`source.repo\` must be a non-empty string like "owner/name"`)
    }
    source.repo = repo.trim()
  }
  const number = field(value, 'number')
  if (number !== undefined && number !== null) {
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`invalid todo at ${label}: \`source.number\` must be a positive integer`)
    }
    source.number = number
  }
  return source
}

/**
 * Enforce the single-active rule across the whole tree.
 * @param items - the parsed tree.
 * @param policy - deployment choices to enforce.
 * @throws when several nodes are active and the deployment forbids it.
 */
function assertSingleActive(items: readonly TodoItem[], policy: TreePolicy): void {
  if (policy.allowParallelActive) return
  const active = collectState(items, 'active')
  if (active.length <= 1) return
  const named = active.map(item => JSON.stringify(item.content)).join(', ')
  throw new Error(`invalid todos: at most one todo may be \`active\` (got ${active.length}: ${named})`)
}

/**
 * Flatten a tree to the preorder list `todo/write` stores.
 * @param items - the canonical tree.
 * @returns one entry per node, children indented two spaces per level.
 */
export function flattenTodoTree(items: readonly TodoItem[]): FlatTodoItem[] {
  const flat: FlatTodoItem[] = []
  const walk = (nodes: readonly TodoItem[], depth: number): void => {
    for (const node of nodes) {
      flat.push({ content: `${'  '.repeat(depth)}${node.content}`, status: wireStatusOf(node.state) })
      if (node.children !== undefined) walk(node.children, depth + 1)
    }
  }
  walk(items, 0)
  return flat
}

/**
 * Rebuild a tree from the upstream flat list by leading indentation.
 * Falls back to a flat root list for lists written without nesting.
 * @param flat - the stored `todo/write` entries.
 * @returns the reconstructed tree.
 */
export function todoTreeFromFlat(flat: readonly FlatTodoItem[]): TodoItem[] {
  const roots: TodoItem[] = []
  const stack: { item: TodoItem; depth: number }[] = []
  for (const entry of flat) {
    const depth = Math.min(MAX_DEPTH, Math.floor((entry.content.length - entry.content.trimStart().length) / 2))
    const item: TodoItem = { content: entry.content.trim(), state: stateOfWireStatus(entry.status) }
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(item)
    else (parent.item.children ??= []).push(item)
    stack.push({ item, depth })
  }
  return roots
}

/**
 * Project a state tree onto the narrative shape the plugin record stores.
 *
 * The state is not repeated here: `todo/write` already carries it as the mapped
 * wire status, and a second copy in the record would be a second field to keep
 * in sync — exactly the dual axis this model removed.
 * @param items - the canonical tree.
 * @returns the same structure without states.
 */
export function detailTreeOf(items: readonly TodoItem[]): TodoDetail[] {
  return items.map(item => {
    const detail: TodoDetail = {
      content: item.content,
      explanation: item.explanation ?? '',
      goal: item.goal ?? '',
    }
    if (item.source !== undefined) detail.source = { ...item.source }
    if (item.children !== undefined && item.children.length > 0) detail.children = detailTreeOf(item.children)
    return detail
  })
}

/**
 * Merge the two trees of one snapshot back into the shape the model writes.
 * @param items - state tree.
 * @param details - narrative tree, structurally aligned.
 * @returns nodes carrying content, state, explanation, goal, and children.
 */
export function mergeTodoTree(items: readonly TodoItem[], details: readonly TodoDetail[]): TodoItem[] {
  return items.map((item, index) => {
    const detail = details[index]
    const merged: TodoItem = {
      content: item.content,
      state: item.state,
      explanation: detail?.explanation ?? '',
      goal: detail?.goal ?? '',
    }
    const source = detail?.source ?? item.source
    if (source !== undefined) merged.source = { ...source }
    if (item.children !== undefined && item.children.length > 0) {
      merged.children = mergeTodoTree(item.children, detail?.children ?? [])
    }
    return merged
  })
}

/**
 * Copy the tree without the narrative fields, for the tool's result value: the
 * model already wrote them, so echoing them back only spends response tokens.
 * @param items - the canonical tree.
 * @returns the same structure carrying content, state, source, children.
 */
export function todoTreeEcho(items: readonly TodoItem[]): TodoItem[] {
  return items.map(item => {
    const node: TodoItem = { content: item.content, state: item.state }
    if (item.source !== undefined) node.source = { ...item.source }
    if (item.children !== undefined && item.children.length > 0) node.children = todoTreeEcho(item.children)
    return node
  })
}

/** State counts of one tree. */
export interface TodoCounts {
  readonly active: number
  readonly inactive: number
  readonly completed: number
}

/**
 * Count every node by state.
 * @param items - the tree to count.
 * @returns counts across all levels.
 */
export function countStates(items: readonly TodoItem[]): TodoCounts {
  return {
    active: collectState(items, 'active').length,
    inactive: collectState(items, 'inactive').length,
    completed: collectState(items, 'completed').length,
  }
}

/**
 * Preorder walk of one state.
 * @param items - the tree to walk.
 * @param state - the state to collect.
 * @returns matching nodes in preorder.
 */
function collectState(items: readonly TodoItem[], state: TodoState): TodoItem[] {
  const found: TodoItem[] = []
  const walk = (nodes: readonly TodoItem[]): void => {
    for (const node of nodes) {
      if (node.state === state) found.push(node)
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(items)
  return found
}

/**
 * Compare a stored detail tree with the flat list written beside it.
 *
 * They are written together, but a foreign writer may have replaced the list
 * since; a mismatch means the details describe a different list and must not be
 * attached to this one.
 * @param details - the recorded narrative tree.
 * @param flat - the current flat list.
 * @returns whether the detail tree's preorder matches the list contents.
 */
export function detailMatchesFlat(details: readonly TodoDetail[], flat: readonly FlatTodoItem[]): boolean {
  const preorder: TodoDetail[] = []
  const walk = (nodes: readonly TodoDetail[]): void => {
    for (const node of nodes) {
      preorder.push(node)
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(details)
  if (preorder.length !== flat.length) return false
  return preorder.every((node, index) => flat[index]!.content.trim() === node.content)
}

/**
 * Attach states from a flat list to a detail tree.
 * @param details - narrative tree whose preorder matches `flat`.
 * @param flat - the wire-status source.
 * @returns the state tree.
 */
export function todoTreeFromDetails(details: readonly TodoDetail[], flat: readonly FlatTodoItem[]): TodoItem[] {
  let cursor = 0
  const walk = (nodes: readonly TodoDetail[]): TodoItem[] => nodes.map(node => {
    const status: TodoWireStatus = flat[cursor++]?.status ?? 'pending'
    const item: TodoItem = { content: node.content, state: stateOfWireStatus(status) }
    if (node.source !== undefined) item.source = { ...node.source }
    if (node.children !== undefined && node.children.length > 0) item.children = walk(node.children)
    return item
  })
  return walk(details)
}
