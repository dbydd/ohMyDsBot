/**
 * The deterministic decision: `meta.to` makes a send, `meta.scope` makes a read,
 * and nothing else is inferred.
 *
 * The library deliberately never picks a plan itself. A host that answers with
 * "the model probably meant X" would make every ambiguity silent; this build
 * refuses instead, and the model-visible surface says so. Routing through a
 * judge is the next slice, not this one.
 *
 * @module omd-onlyne/decide
 */

import { OnlyneError } from '@onlyne/lib'
import type { Action, Json, MessageRef, MsgInput, ThreadRef } from '@onlyne/lib'

/** The read scopes the library dispatches without a peer-owned resource query. */
const READ_SCOPES = ['directory', 'neighbors', 'threads', 'inbox', 'messages', 'message', 'evidence'] as const

type ReadScope = (typeof READ_SCOPES)[number]

function isReadScope(value: string): value is ReadScope {
  return (READ_SCOPES as readonly string[]).includes(value)
}

function isJsonRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A thread reference carried by `meta.thread`; a malformed one is not a reference. */
function threadRef(value: Json | undefined): ThreadRef | undefined {
  if (!isJsonRecord(value)) return undefined
  const { owner, id } = value
  if (typeof owner !== 'string' || owner === '' || typeof id !== 'string' || id === '') return undefined
  return { owner, id }
}

/** A message reference carried by `meta.in_reply_to`. */
function messageRef(value: Json | undefined): MessageRef | undefined {
  if (!isJsonRecord(value)) return undefined
  const { sender, id } = value
  if (typeof sender !== 'string' || sender === '' || typeof id !== 'string' || id === '') return undefined
  return { sender, id }
}

/**
 * Turn one `msg` input into the action the library executes.
 *
 * A read is the whole `meta.scope` family: the library dispatches it against
 * this node's own records, or against the owner that holds them. A send must
 * name `meta.to`; the thread, the reply link and the relation are passed through
 * only when they are well-formed, so a typo degrades to "no thread" instead of
 * addressing a different conversation.
 *
 * @param input - the model's `delivery_kind`, `msg` and `meta`.
 * @returns the action to execute.
 * @throws {@link OnlyneError} `invalid_request` when neither a scope nor a target is named.
 */
export async function decideMessage(input: MsgInput): Promise<Action> {
  const meta = input.meta ?? {}

  const scope = meta.scope
  if (scope !== undefined && scope !== null) {
    if (typeof scope !== 'string' || !isReadScope(scope)) {
      throw new OnlyneError('invalid_request', `meta.scope must be one of ${READ_SCOPES.join(', ')}.`)
    }
    const thread = threadRef(meta.thread)
    const message = messageRef(meta.message)
    const pageSize = meta.page_size
    return {
      kind: 'read',
      scope,
      ...(thread === undefined ? {} : { thread }),
      ...(message === undefined ? {} : { message }),
      ...(typeof meta.cursor === 'string' && meta.cursor !== '' ? { cursor: meta.cursor } : {}),
      ...(typeof meta.seq === 'string' && meta.seq !== '' ? { seq: meta.seq } : {}),
      ...(typeof pageSize === 'number' && Number.isInteger(pageSize) && pageSize > 0 ? { page_size: pageSize } : {}),
      ...(meta.attention === 'inbox' || meta.attention === 'thread' ? { attention: meta.attention } : {}),
    }
  }

  const to = meta.to
  if (typeof to !== 'string' || to === '') {
    throw new OnlyneError(
      'invalid_request',
      'A send names its target in meta.to (a node id such as urn:onlyne:agent:<sessionId>); this build routes nothing without one.',
    )
  }
  const thread = threadRef(meta.thread)
  const inReplyTo = messageRef(meta.in_reply_to)
  const relation = meta.relation === 'reply' || meta.relation === 'followup' ? meta.relation : undefined
  return {
    kind: 'send',
    to,
    ...(thread === undefined ? {} : { thread }),
    ...(inReplyTo === undefined ? {} : { in_reply_to: inReplyTo, relation: relation ?? 'reply' }),
    ...(typeof meta.context === 'string' && meta.context !== '' ? { context: meta.context } : {}),
    // `async` is the honest plan for a host with no maintenance-free waiter: the
    // send is admitted and the caller reads its outcome, while the reply arrives
    // at this node's own inbox as a separate delivery.
    response: 'async',
    execution: 'existing',
  }
}
