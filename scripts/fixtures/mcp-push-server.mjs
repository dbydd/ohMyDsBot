#!/usr/bin/env node
/**
 * A minimal MCP server that pushes, for verifying subscription paths end to end.
 *
 * It speaks newline-delimited JSON-RPC over stdio with no dependencies and
 * implements just enough of the 2025-06-18 revision to exercise resources,
 * resource templates and `resources/subscribe`: after a subscribe, it emits
 * `notifications/resources/updated` on a timer so a caller can see the change
 * arrive without polling anything.
 *
 * Environment:
 *   FIXTURE_PUSH_MS   interval between updates after a subscribe (default 1000)
 *   FIXTURE_TOOLS     number of tools to report (default 3); changing it later
 *                     is not implemented — the list is stable
 */

const PUSH_MS = Number(process.env.FIXTURE_PUSH_MS ?? 1000)
const TOOL_COUNT = Number(process.env.FIXTURE_TOOLS ?? 3)

const RESOURCES = [
  {
    uri: 'fixture://notes/alpha',
    name: 'alpha',
    title: 'Alpha note',
    description: 'One short note, readable as plain text.',
    mimeType: 'text/plain',
  },
]

const TEMPLATES = [
  {
    uriTemplate: 'fixture://items/{id}',
    name: 'item',
    description: 'One item by id.',
    mimeType: 'text/plain',
  },
]

const tools = Array.from({ length: TOOL_COUNT }, (_, index) => ({
  name: index === 0 ? 'echo' : `echo_${index}`,
  description: 'Return the text it was given.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to return.' } },
    required: ['text'],
  },
}))

const subscriptions = new Map()
let tick = 0

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function readResource(uri) {
  if (uri.startsWith('fixture://items/')) {
    const id = decodeURIComponent(uri.slice('fixture://items/'.length))
    return { contents: [{ uri, mimeType: 'text/plain', text: `item ${id} at tick ${tick}` }] }
  }
  const known = RESOURCES.find(entry => entry.uri === uri)
  if (known === undefined) {
    throw new Error(`no such resource: ${uri}`)
  }
  return { contents: [{ uri, mimeType: 'text/plain', text: `alpha at tick ${tick}` }] }
}

function push(uri) {
  send({
    jsonrpc: '2.0',
    method: 'notifications/resources/updated',
    params: { uri },
  })
}

setInterval(() => {
  if (subscriptions.size === 0) {
    return
  }
  tick += 1
  for (const uri of subscriptions.keys()) {
    push(uri)
  }
}, PUSH_MS)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line !== '') {
      handle(JSON.parse(line))
    }
    newline = buffer.indexOf('\n')
  }
})

function handle(message) {
  const { id, method, params } = message
  if (method === undefined) {
    return
  }
  if (id === undefined) {
    // Notifications from the client (initialized, cancelled) need no answer.
    return
  }
  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: true, listChanged: false },
          prompts: {},
        },
        serverInfo: { name: 'fixture-push', version: '0.0.1' },
      })
      return
    case 'ping':
      result(id, {})
      return
    case 'tools/list':
      result(id, { tools })
      return
    case 'tools/call': {
      const text = params?.arguments?.text ?? ''
      result(id, { content: [{ type: 'text', text: String(text) }] })
      return
    }
    case 'resources/list':
      result(id, { resources: RESOURCES })
      return
    case 'resources/templates/list':
      result(id, { resourceTemplates: TEMPLATES })
      return
    case 'resources/read':
      try {
        result(id, readResource(params?.uri ?? ''))
      } catch (error) {
        failure(id, -32602, error.message)
      }
      return
    case 'resources/subscribe': {
      const uri = params?.uri ?? ''
      subscriptions.set(uri, true)
      result(id, {})
      return
    }
    case 'resources/unsubscribe': {
      subscriptions.delete(params?.uri ?? '')
      result(id, {})
      return
    }
    case 'prompts/list':
      result(id, { prompts: [] })
      return
    default:
      failure(id, -32601, `method not found: ${method}`)
  }
}

process.stderr.write(`fixture-push: pushMs=${PUSH_MS} tools=${TOOL_COUNT}\n`)
