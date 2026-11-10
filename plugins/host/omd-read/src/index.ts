/**
 * `read` with omp-style path selectors, inline images, and internal resource
 * addresses, over `ctx.fs` and `ctx.internalPaths`.
 *
 * Mounting this tool replaces the upstream `read`/`read_image` pair: one tool
 * answers for both text and images, so the model has one verb and one argument.
 * Selectors live in the path (`file.ts:50-200`), while a plain path keeps the
 * upstream `offset`/`limit` behavior. Reads still emit `fs/observed`, so the
 * write/edit guards keep their freshness baseline.
 *
 * A path is an internal address when it is the canonical `dsh-resource://<source>/…`
 * form or the shorthand of a source that registers one (`skill://<name>`). Every
 * other path — `file://` included — is a filesystem path, and the internal path
 * service owns the wording for an address it cannot resolve.
 *
 * @module omd-read
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { imageMediaTypeForPath, formatImageRead, sniffImageMediaType } from './image.ts'
import { buildWindow, formatRead, parseSelectorSuffix, splitPathSelector } from './selector.ts'
import type { Selector } from './selector.ts'
// Type-only: omd plugins carry no workspace edge to each other, so the service
// declaration comes from the sibling package's source and is erased at load.
import type { InternalPathsService } from '../../omd-internal-paths/src/index.ts'

/** Services required to register the tool. `attachments`, `skills`, and `llm` are optional at call time. */
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory', 'internalPaths']

/** Tool name that replaces the upstream pair. */
export const name = 'omd-read'

/** Plugin configuration. */
export interface Config {
  /** `selector` accepts `file.ts:50-200`; `native` keeps one forward window only. */
  mode: Volatile<'selector' | 'native'>
  /** Prefix every text line with `N|`. */
  lineNumbers: Volatile<boolean>
  /** Lines returned when the caller names no limit, and the per-call ceiling for a raw path. */
  defaultLimit: Volatile<number>
  /** Decode images inline through the attachment service. */
  images: Volatile<boolean>
  /** Hard cap on returned lines for any one call. */
  maxLines: number
  /** Lines kept before an explicitly bounded single range. */
  contextBefore: Volatile<number>
  /** Lines kept after an explicitly bounded single range. */
  contextAfter: Volatile<number>
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes a text window returns for one call; images are bounded by the attachment store instead. */
  maxBytes: number
  /** Files at or above this size stream instead of loading whole. */
  streamMinSize: number
}

export const Config: z<Config> = z.object({
  mode: z.union(['selector', 'native']).default('selector')
    .volatile()
    .description('`selector` reads `path:50-200`, `path:-60`, `path:5-16,900-910`; `native` reads one window from `offset`.'),
  lineNumbers: z.boolean().default(true)
    .volatile()
    .description('Prefix each line with its number and a `|`.'),
  defaultLimit: z.natural().default(500)
    .volatile()
    .description('Lines returned when the caller names no limit.'),
  images: z.boolean().default(true)
    .volatile()
    .description('Decode PNG/JPEG/WebP/GIF paths into an image block.'),
  maxLines: z.natural().default(2000).description('Hard cap on returned lines per call.'),
  contextBefore: z.natural().default(1)
    .volatile()
    .description('Lines kept before an explicitly bounded single range, so the caller sees what precedes it.'),
  contextAfter: z.natural().default(3)
    .volatile()
    .description('Lines kept after an explicitly bounded single range.'),
  maxLineLength: z.natural().default(2000).description('Maximum characters returned for one line.'),
  maxBytes: z.natural().default(50 * 1024).description('Maximum bytes a text window returns per call. Images are bounded by the attachment store.'),
  streamMinSize: z.natural().default(10 * 1024 * 1024).description('Files at or above this size stream.'),
})

/**
 * The structured value of an image read. The `image` property that carries it
 * is optional — a text read has none — so this object declares no property-level
 * `required` flag of its own.
 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const

/** What one read produced: a text window, or an image reference. */
interface ReadValue {
  path: string
  offset?: number
  lines?: { number: number; text: string }[]
  totalLines?: number
  /** The window dropped lines the request asked for at a line or byte cap. */
  truncated?: boolean
  /** The selector asked for unnumbered text (`path:raw`). */
  raw?: boolean
  image?: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
    originalDimensions?: { width: number; height: number }
  }
}

/** What one card renders, declared on the result so the client never parses the model-facing text. */
type ReadPresentation =
  | {
    /** A file read, shown as a line-numbered code view. */
    kind: 'text'
    /** The path argument as the model wrote it, selector included. */
    requested: string
    /** The resolved path the read opened, for the banner and the file link. */
    path: string
    /** The 1-based first line the window asked for; preserved when the window is empty. */
    offset: number
    lines: { number: number; text: string }[]
    totalLines: number
    /** The window dropped lines the request asked for at a line or byte cap. */
    truncated: boolean
  }
  | {
    /** A `scheme://` resource read: the same code view, without a file to open. */
    kind: 'resource'
    requested: string
    scheme: string
    offset: number
    lines: { number: number; text: string }[]
    totalLines: number
    truncated: boolean
  }
  | {
    /** An inline image, shown through the gallery with its pixel facts. */
    kind: 'image'
    requested: string
    /** The resolved path the image was read from. */
    path: string
    image: NonNullable<ReadValue['image']>
  }

/** The call arguments a card derivation reads. */
interface ReadArgs {
  path: string
  file_path?: string
}

/** The canonical internal scheme; a path carrying it is never a file. */
const CANONICAL_PREFIX = /^dsh-resource:/iu

/** `file://` is a filesystem path spelled with a scheme. */
const FILE_SCHEME = /^file:\/\//iu

/**
 * Whether a request belongs to the internal path service rather than the filesystem.
 *
 * The canonical scheme always does. The `source://` shorthand counts only for a
 * registered source, so a file named `skill:12` — and a stray `foo://bar` — stay
 * filesystem paths. This decides only who owns the request; whether that source
 * accepts the address, and the wording when it does not, is the service's.
 * @param service - the internal path registry.
 * @param address - the model-supplied path.
 * @returns true when the service owns the address.
 */
function isInternalAddress(service: InternalPathsService, address: string): boolean {
  if (FILE_SCHEME.test(address)) return false
  if (CANONICAL_PREFIX.test(address)) return true
  if (service.resolve(address) !== undefined) return true
  return service.sources().some(source => address.startsWith(`${source.source}://`))
}

/**
 * Build the card identity for one settled read. `tool/result.data.meta` is opaque
 * to the core and never reaches the model, so this is the only channel that can
 * carry the window's structure to a UI; every value is plain JSON.
 * @param service - the internal path registry, which names the resource's source.
 * @param args - the validated call arguments.
 * @param value - the read's structured output.
 * @returns the discriminated card payload.
 */
function readPresentation(service: InternalPathsService, args: ReadArgs, value: ReadValue): ReadPresentation {
  // The authored path carries any selector the model wrote (`src/a.ts:50-200`).
  const requested = (typeof args.path === 'string' && args.path.trim() !== '' ? args.path : args.file_path) ?? ''
  if (value.image !== undefined) {
    return { kind: 'image', requested, path: value.path, image: { ...value.image } }
  }
  const window = {
    offset: value.offset ?? 0,
    lines: (value.lines ?? []).map(line => ({ number: line.number, text: line.text })),
    totalLines: value.totalLines ?? value.lines?.length ?? 0,
    truncated: value.truncated === true,
  }
  const source = isInternalAddress(service, requested) ? service.resolve(requested)?.source : undefined
  return source === undefined
    ? { kind: 'text', requested, path: value.path, ...window }
    : { kind: 'resource', requested, scheme: source, ...window }
}

/** A resolved regular file: the target plus its single stat result. */
interface RegularFile {
  target: FsTarget
  info: FsInfo
}

/**
 * Refuse an image read on a route that does not declare image input.
 * @param ctx - plugin context carrying the optional `llm` service.
 * @param exec - the tool execution, whose agent names the routed model.
 * @param requestedPath - the path shown in the refusal.
 */
async function assertImageCapableRoute(ctx: Context, exec: ToolExecution, requestedPath: string): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input`)
  }
}

/** Resolve, observe, and require a regular file. */
async function resolveRegular(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
  cwd: string | undefined,
): Promise<RegularFile> {
  const target = await ctx.fs.resolve(requestedPath, { ...cwd !== undefined ? { cwd } : {}, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}

/** Bytes a signature check spans: WebP puts its marker at offset 8. */
const SIGNATURE_BYTES = 12

/** Byte ceiling the attachment store enforces on one image. */
function imageByteCap(attachments: AttachmentStore): number {
  return Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
}

/**
 * Media type for a file that may be an image.
 *
 * The leading bytes are the authority: a `.png` holding text is read as text,
 * and a PNG misnamed `.txt` still comes back as an image. The extension only
 * stands in when the window cannot be read at all — permissions, a racing
 * truncation, a backend without a range read — because a signature check that
 * fails must not cost the caller a text read.
 * @param ctx - plugin context carrying the filesystem service.
 * @param target - the resolved file.
 * @param signal - aborts the window read.
 * @param declared - the media type the path's extension declares, if any.
 * @returns the media type to decode as, or undefined for a text read.
 */
async function sniffImage(
  ctx: Context,
  target: FsTarget,
  signal: AbortSignal,
  declared: ImageMediaType | undefined,
): Promise<ImageMediaType | undefined> {
  let window: Uint8Array
  try {
    // A window, not the whole file: `readBytes` caps the complete content and
    // fails a larger file, so sniffing through it rejected every text file
    // bigger than the window.
    window = await ctx.fs.readByteRange(target, { offset: 0, length: SIGNATURE_BYTES }, signal)
  } catch {
    return declared
  }
  return sniffImageMediaType(window)
}

/** Store an image and build its structured value. */
async function readImage(
  ctx: Context,
  exec: ToolExecution,
  attachments: AttachmentStore,
  file: RegularFile,
  declared: ImageMediaType | undefined,
): Promise<ReadValue> {
  const { target, info } = file
  const byteCap = imageByteCap(attachments)
  const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
  const mediaType = declared ?? sniffImageMediaType(data)
  if (mediaType === undefined) {
    throw new Error(`cannot read "${target.displayPath}": not a supported image format (PNG/JPEG/WebP/GIF)`)
  }
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`cannot read "${target.displayPath}": ${mediaType} images are not accepted by this deployment`)
  }
  let ref: ImageAttachmentRef
  try {
    ref = await attachments.saveImage({ data, mediaType, name: target.displayPath.split('/').pop() ?? 'image' })
  } catch (error: unknown) {
    if (!(error instanceof AttachmentError)) throw error
    if (error.code === 'IMAGE_DIMENSION_TOO_LARGE') {
      throw new Error(`cannot read "${target.displayPath}": a side exceeds ${attachments.imageLimits.maxImageDimension}px; downscale it first`, { cause: error })
    }
    if (error.code === 'IMAGE_TOO_MANY_PIXELS') {
      throw new Error(`cannot read "${target.displayPath}": exceeds the ${attachments.imageLimits.maxImagePixels}-pixel limit; downscale it first`, { cause: error })
    }
    if (error.code === 'IMAGE_TOO_LARGE') {
      throw new Error(`cannot read "${target.displayPath}": cannot be stored within the deployment's byte limits`, { cause: error })
    }
    throw error
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return {
    path: ctx.fs.processPath(target),
    image: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
      ...ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } },
    },
  }
}

/**
 * Register the tool and its prompt guidance.
 * @param ctx - plugin context with the filesystem, tools, prompt, and working-directory services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // `skill` is the first internal path source: the model may write
  // `skill://<name>` (the shorthand this source declares) or the canonical
  // `dsh-resource://skill/<name>` the web half also reads.
  ctx.effect(() => ctx.internalPaths.register('skill', {
    grammar: 'skill://<name> or dsh-resource://skill/<name>',
    shorthand: true,
    live: false,
    async read(name, exec) {
      const skills = ctx.get('skills')
      if (skills === undefined) throw new Error('cannot read a skill: no skill registry is mounted')
      // The skill registry is layered by agent scope: a lookup missing the
      // caller's identity resolves the global layer alone and misses every
      // skill a preset mounts. `{ cwd, signal, scope: agent }` is the same
      // lookup upstream `tool-skill` builds.
      const cwd = exec.cwd
        ?? (exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal))
      const lookup = { cwd, signal: exec.signal, scope: exec.agent }
      const skill = await skills.get(name, lookup)
      if (skill !== undefined) return renderSkillContent(skill)
      const available = (await skills.list(lookup)).filter(isModelInvocable).map(candidate => candidate.name)
      throw new Error(`cannot read "skill://${name}": no such skill${available.length === 0 ? '' : ` (available: ${available.join(', ')})`}`)
    },
  }))

  ctx.systemPrompt.section({
    name: 'tool:read',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: ({ scope }) => ctx.tools.get('read', scope) === undefined
      ? ''
      : 'Use `read` — not shell commands — for files. Put the range in the path: `src/a.ts:50-200`, `:-60` for the last 60 lines, `:5-16,900-910` for several ranges, `:raw` for unnumbered text. Images (PNG/JPEG/WebP/GIF) come back as images.',
  })

  const read = defineTool({
    name: 'read',
    description: 'Read a file: text with line numbers, or an image (PNG/JPEG/WebP/GIF) inline. '
      + 'Put the range in the path — `a.ts:50-200`, `:-60`, `:5-16,900-910`, `:raw` — or pass `offset`/`limit` for one forward window. '
      + 'An internal resource address reads that source instead of a file: `dsh-resource://<source>/<path>`, or the source\'s own shorthand such as `skill://<name>`.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute or workspace-relative path, or an internal resource address, optionally with a `:range` selector.' },
      file_path: { type: 'string', description: 'Legacy alias for `path`.' },
      offset: { type: 'number', description: '1-based first line when no selector is used.' },
      limit: { type: 'number', description: 'Lines to return when no selector is used.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer' },
          truncated: { type: 'boolean' },
          raw: { type: 'boolean' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value: ReadValue): ContentBlock[] => {
        if (value.image !== undefined) {
          return [
            { type: 'text', text: formatImageRead(value.path, value.image) },
            {
              type: 'image',
              attachment: {
                attachmentId: AttachmentId(value.image.attachmentId),
                mediaType: value.image.mediaType,
                bytes: value.image.bytes,
                width: value.image.width,
                height: value.image.height,
                ...value.image.name === undefined ? {} : { name: value.image.name },
                ...value.image.originalDimensions === undefined
                  ? {}
                  : { originalDimensions: { ...value.image.originalDimensions } },
              },
            },
          ]
        }
        const lines = value.lines ?? []
        const total = value.totalLines ?? lines.length
        const first = lines[0]?.number ?? value.offset ?? 1
        const last = lines.at(-1)?.number ?? 0
        const footer = last >= total
          ? `(End of file - total ${total} lines)`
          : `(Showing lines ${first}-${last} of ${total}. Use \`offset=${last + 1}\` to continue.)`
        return [{
          type: 'text',
          text: formatRead(value.path, {
            lines,
            totalLines: total,
            truncatedByBytes: false,
            beyondEnd: [],
          }, { lineNumbers: config.lineNumbers.get() && value.raw !== true, footer }),
        }]
      },
      presentationMeta: (args, value: ReadValue) => readPresentation(ctx.internalPaths, args, value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const rawPath = (typeof args.path === 'string' && args.path.trim() !== '' ? args.path : args.file_path) ?? ''
      if (rawPath.trim() === '') throw new Error('path must be a non-empty string')
      const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)

      // An internal address is the service's to settle, success or failure: it
      // owns the roster, so an unknown source and a shorthand that source never
      // declared are reported with what is registered and its grammar.
      if (isInternalAddress(ctx.internalPaths, rawPath)) {
        // `cwd` is what a repository-bound source resolves relative paths against;
        // `agent` names the caller for sources that own per-agent state.
        const reader = {
          signal: exec.signal,
          ...cwd === undefined ? {} : { cwd },
          ...exec.agent === undefined ? {} : { agent: exec.agent },
        }
        const text = await ctx.internalPaths.read(rawPath, reader)
        if (typeof text !== 'string') {
          throw new Error(`cannot read "${rawPath}": this source returns bytes, not text`)
        }
        const window = await buildWindow([text], {
          offset: args.offset ?? 1,
          limit: args.limit ?? config.defaultLimit.get(),
          maxLines: config.maxLines,
          contextBefore: config.contextBefore.get(),
          contextAfter: config.contextAfter.get(),
          maxLineLength: config.maxLineLength,
          maxBytes: config.maxBytes,
        }, rawPath)
        return {
          path: rawPath,
          offset: window.lines[0]?.number ?? 1,
          lines: window.lines,
          totalLines: window.totalLines,
          truncated: window.truncatedByBytes,
        }
      }

      // A literal path wins over the selector reading, so a file named `a.ts:12` stays readable.
      let pathArg = rawPath.replace(FILE_SCHEME, '')
      let selector: Selector | undefined
      let raw = false
      if (config.mode.get() === 'selector') {
        const split = splitPathSelector(pathArg)
        if (split.suffix !== undefined) {
          const parsed = parseSelectorSuffix(split.suffix)
          if (parsed !== undefined) {
            const literal = await ctx.fs.resolve(pathArg, { signal: exec.signal })
            if (await ctx.fs.stat(literal, exec.signal) === undefined) {
              raw = parsed.raw
              // A bare `:raw` keeps the default forward window; only the numbering goes.
              if (parsed.ranges.length > 0) selector = parsed
              pathArg = split.path
            }
          }
        }
      }

      const file = await resolveRegular(ctx, exec, pathArg, cwd)
      const { target, info } = file

      const declared = imageMediaTypeForPath(target.displayPath)
      const attachments = ctx.get('attachments')
      // Images are sized by the attachment store, never by `maxBytes`: that cap
      // bounds the text window, and spending it here gated the text path too.
      if (config.images.get() && attachments !== undefined
        && (declared !== undefined || (info.size ?? 0) <= imageByteCap(attachments))) {
        const sniffed = await sniffImage(ctx, target, exec.signal, declared)
        if (sniffed !== undefined) {
          await assertImageCapableRoute(ctx, exec, target.displayPath)
          return await readImage(ctx, exec, attachments, file, sniffed)
        }
      }

      const chunks = info.size === undefined || info.size >= config.streamMinSize
        ? await ctx.fs.streamText(target, exec.signal)
        : [await ctx.fs.readText(target, exec.signal)]
      const window = await buildWindow(chunks, {
        ...selector === undefined ? {} : { selector },
        offset: args.offset ?? 1,
        limit: args.limit ?? config.defaultLimit.get(),
        maxLines: config.maxLines,
        contextBefore: config.contextBefore.get(),
        contextAfter: config.contextAfter.get(),
        maxLineLength: config.maxLineLength,
        maxBytes: config.maxBytes,
      }, target.displayPath)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return {
        path: ctx.fs.processPath(target),
        offset: selector === undefined ? args.offset ?? 1 : window.lines[0]?.number ?? 1,
        lines: window.lines,
        totalLines: window.totalLines,
        truncated: window.truncatedByBytes,
        ...raw ? { raw: true } : {},
      }
    },
    presentCall(args): GenericCallView {
      const raw = typeof args.path === 'string' && args.path !== '' ? args.path : args.file_path ?? ''
      return {
        card: 'generic',
        title: `Read ${raw}`,
        kind: 'read',
        locations: [{ path: raw.split(':').at(0) ?? raw, line: args.offset ?? 1 }],
      }
    },
  })

  ctx.effect(() => ctx.tools.register(read))
  // An agent preset registers its own tools in a scope nearer the agent than
  // this plugin's, so the preset's upstream `read`/`read_image` (the pair this
  // tool replaces) shadow the global registration and the model never sees it.
  // The agent's own scope is the nearest layer: registering there wins, and
  // denying the inherited image verb removes the second verb. Both live on the
  // agent's context, so they unwind with the agent.
  ctx.on('agent/created', ({ agent }) => {
    // `get`, not `agent.ctx.tools`: property access demands an `inject` this
    // plugin's context does not carry for another context's service.
    const tools = agent.ctx.get('tools')
    if (tools === undefined) return
    tools.register(read)
    const inherited = new Set(tools.schemas(agent).map(tool => tool.name))
    const deny = ['read_image'].filter(name => inherited.has(name))
    if (deny.length > 0) tools.restrict({ deny })
  })
}
