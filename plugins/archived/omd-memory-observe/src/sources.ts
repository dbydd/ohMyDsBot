/**
 * The source-kind filter between a session log and a retain payload.
 *
 * The filter is a type, not a chain of runtime comparisons: only the kinds in
 * {@link RetainedSourceKind} can be represented as a {@link RetainedSource}, so
 * a component that consumes a segment cannot meet an excluded message at all.
 * A producer that adds a new `MessageSourceMap` kind — the recall injection's
 * `memory` kind included — is therefore excluded by construction, and a
 * producer that ships context (`form: 'instructions' | 'catalog' | 'snapshot' |
 * 'notice' | 'relay' | 'recall'`) is excluded even when it reuses a
 * conversation kind.
 *
 * {@link isRetainedSource} is the one runtime mirror of that type. It narrows;
 * it never decides a policy the type does not already state.
 *
 * @module omd-memory-observe/sources
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'

/**
 * Kinds whose content is conversation a memory bank may keep: a human prompt,
 * a model answer, and the result of a tool the model asked for. Everything the
 * harness authors or injects is context, not conversation.
 */
export type RetainedSourceKind = 'user' | 'model' | 'tool'

/**
 * The retained kinds as a runtime lookup. Keying the object by the union means
 * adding a kind to {@link RetainedSourceKind} without adding it here — or the
 * reverse — is a type error.
 */
const RETAINED: { readonly [K in RetainedSourceKind]: true } = { user: true, model: true, tool: true }

/**
 * Sources that carry no producer-supplied context form. `kind` stays in the
 * target so the "weak type" rule does not reject a source that simply has no
 * `form` key; `form?: never` then excludes every producer that does.
 */
type ContextlessSource = Extract<
  MessageSource,
  { readonly kind: string; readonly form?: never }
>

/**
 * A message source the retain path may read: a conversation kind with no
 * context form. Unrepresentable variants include every injected context
 * producer and every future merge-extended kind.
 */
export type RetainedSource = Extract<ContextlessSource, { readonly kind: RetainedSourceKind }>

/**
 * Narrow one logged source to the retained vocabulary.
 * @param source - the source recorded on a message event.
 * @returns whether the message is conversation the memory bank may keep.
 */
export function isRetainedSource(source: MessageSource): source is RetainedSource {
  // An own `form` key is how a producer marks injected context; absent means
  // the message is conversation. Reading the key's presence, not its value,
  // keeps `form: undefined` from passing as a human prompt.
  if (Object.hasOwn(source, 'form')) return false
  return Object.hasOwn(RETAINED, source.kind)
}
