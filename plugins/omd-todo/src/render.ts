/**
 * Markdown view of one todo tree for `dsh-resource://todo/…`.
 *
 * The same text serves the model reading a path and the web side previewing
 * one, so it is written once here. Each state gets its own mark: `[active]` is
 * the step being worked on, `[ ]` is planned but not now, `[x]` is done. A
 * checkbox alone could not say the first two apart.
 *
 * @module omd-todo/render
 */

import { MAX_DEPTH, countStates, mergeTodoTree } from './tree.ts'
import type { TodoDetail, TodoItem, TodoSnapshot, TodoState } from './types.ts'

/** Mark per state; `[active]` widens the checkbox so it cannot be skimmed as pending. */
const STATE_MARK: Record<TodoState, string> = {
  active: '[active]',
  inactive: '[ ]',
  completed: '[x]',
}

const LEGEND = '`[active]` being worked on · `[ ]` planned, not now · `[x]` completed'

/**
 * Render one whole session tree.
 * @param sessionId - the session the list belongs to.
 * @param snapshot - the folded list, or null before the first write.
 * @returns markdown text.
 */
export function renderTodoSnapshot(sessionId: string, snapshot: TodoSnapshot | null): string {
  if (snapshot === null) {
    return [
      `# Todo — ${sessionId}`,
      '',
      'This session has no todo list yet. `todo_write` creates one.',
      '',
    ].join('\n')
  }
  const merged = mergeTodoTree(snapshot.items, snapshot.details)
  const counts = countStates(merged)
  const total = counts.active + counts.inactive + counts.completed
  const header = [
    `# Todo — ${sessionId}`,
    '',
    `${total} item(s): ${counts.active} active, ${counts.inactive} inactive, ${counts.completed} completed.`,
    '',
    LEGEND,
    '',
  ]
  if (merged.length === 0) return [...header, 'The list is empty.', ''].join('\n')
  return [...header, ...renderNodes(merged, 0), ''].join('\n')
}

/**
 * Render one selected node and its subtree.
 * @param sessionId - the session the list belongs to.
 * @param address - the address that selected the node, for the heading.
 * @param item - the selected state node.
 * @param detail - its narrative node.
 * @returns markdown text.
 */
export function renderTodoSelection(sessionId: string, address: string, item: TodoItem, detail: TodoDetail): string {
  const merged = mergeTodoTree([item], [detail])[0]!
  return [
    `# Todo — ${sessionId} — ${address}`,
    '',
    LEGEND,
    '',
    ...renderNodes([merged], 0),
    '',
  ].join('\n')
}

/**
 * Resolve a 1-based index path against one snapshot.
 * @param snapshot - the folded list.
 * @param indices - 1-based indices, outermost first, at most three long.
 * @param address - the original address, quoted in errors.
 * @returns the selected state node and its aligned narrative node.
 * @throws when a level does not exist.
 */
export function selectTodoNode(
  snapshot: TodoSnapshot,
  indices: readonly number[],
  address: string,
): { item: TodoItem; detail: TodoDetail } {
  if (indices.length > MAX_DEPTH + 1) {
    throw new Error(
      `cannot read "${address}": an address names at most ${MAX_DEPTH + 1} levels (for example 1.2.3)`,
    )
  }
  let items: readonly TodoItem[] = snapshot.items
  let details: readonly TodoDetail[] = snapshot.details
  let item: TodoItem | undefined
  let detail: TodoDetail | undefined
  for (const [level, index] of indices.entries()) {
    item = items[index - 1]
    if (item === undefined) {
      const available = items.length === 0 ? 'none' : `1 … ${items.length}`
      throw new Error(
        `cannot read "${address}": level ${level + 1} has no item ${index} — it holds ${items.length} item(s) (${available})`,
      )
    }
    detail = details[index - 1]
    if (detail === undefined) throw new Error(`cannot read "${address}": the stored detail tree is shorter than the list at level ${level + 1}`)
    items = item.children ?? []
    details = detail.children ?? []
  }
  return { item: item!, detail: detail! }
}

/**
 * Render one node list at its depth.
 * @param nodes - nodes to render.
 * @param depth - indentation level.
 * @returns markdown lines.
 */
function renderNodes(nodes: readonly TodoItem[], depth: number): string[] {
  const lines: string[] = []
  for (const node of nodes) {
    lines.push(`${'  '.repeat(depth)}- ${STATE_MARK[node.state]} ${inline(node.content)}${suffix(node)}`)
    if (node.children !== undefined && node.children.length > 0) lines.push(...renderNodes(node.children, depth + 1))
  }
  return lines
}

/**
 * Append the narrative and provenance of one node.
 * @param node - the node to describe.
 * @returns the inline suffix, possibly empty.
 */
function suffix(node: TodoItem): string {
  const parts: string[] = []
  if (node.goal !== undefined && node.goal !== '') parts.push(`目标：${inline(node.goal)}`)
  if (node.explanation !== undefined && node.explanation !== '') parts.push(`前因后果：${inline(node.explanation)}`)
  if (node.source !== undefined) {
    const where = node.source.repo === undefined ? '' : `${node.source.repo}`
    const number = node.source.number === undefined ? '' : `#${node.source.number}`
    parts.push(`来源：${node.source.kind}${where === '' ? '' : ` ${where}`}${number}`)
  }
  return parts.length === 0 ? '' : ` — ${parts.join(' — ')}`
}

/**
 * Collapse whitespace so one entry stays on one markdown line.
 * @param text - the field value.
 * @returns a single-line form.
 */
function inline(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}
