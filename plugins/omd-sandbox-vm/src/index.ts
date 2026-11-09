/**
 * `omd-sandbox-vm` — isolated ARM64 Linux machines for agent command execution,
 * each with a guest desktop a human can open and take over. It publishes
 * `ctx.sandboxVm` and the `vm://` internal paths.
 *
 * The layer split the seam carries is the whole design: the agent, its session
 * and its files stay on the host; the workspace is a host directory mounted
 * into the machine; only command execution and the desktop cross the boundary.
 * That is why a machine is worth describing as a path rather than as a tool —
 * its state is something a caller reads and watches, while the machine's work
 * is still `exec`.
 *
 * `vm://` is read-only on purpose. A machine is created by `provision` under a
 * name the caller chose, and nothing else about it is a document: there is no
 * writable path here, so nothing in this source can be edited into a broken
 * machine by a text write.
 *
 * Two host routes serve a human's browser, and they are not the same thing: one
 * mints the credential that opens a desktop, the other serves a frame of it.
 * A frame carries no credential, so a card can show the room; the address that
 * lets a human walk in stays behind a click.
 *
 * @module omd-sandbox-vm
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createSandboxVm, DesktopUnavailable, MACHINE_NAME, type MachineSnapshot, type SandboxVm } from './machine.ts'
import type { SandboxService, SandboxState } from './types.ts'
import type { InternalSource } from '../../omd-internal-paths/src/index.ts'

export type {
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxRequest,
  SandboxService,
  SandboxState,
} from './types.ts'
export { OrbctlError } from './orbctl.ts'
export type { OrbctlInvocation, OrbctlOutcome } from './orbctl.ts'
export { createSandboxVm, DesktopUnavailable, MACHINE_NAME } from './machine.ts'
export type { DesktopAccess, MachineSnapshot, SandboxVm, SandboxVmSettings } from './machine.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Isolated machines; present only while this plugin is mounted. */
    sandboxVm: SandboxService
  }
}

/** Plugin id the Loader entry carries. */
export const name = 'omd-sandbox-vm'

/** The `vm://` source needs the internal-path registry, so the entry requires it. */
export const inject = ['internalPaths']

/** Source name the machines live under. */
const SOURCE = 'vm'

/**
 * The route a human's browser mints a desktop address from.
 *
 * `/api` answers only to the launch-token cookie, so this route is the trust
 * boundary itself: the model reaches internal paths, not this.
 */
const DESKTOP_ROUTE = '/api/plugins/omd-sandbox-vm/desktop'

/**
 * The route that serves one frame of a machine's desktop as PNG.
 *
 * Its answer is a picture, not an address: no credential is minted here and
 * none is returned, so showing a frame hands out nothing a viewer could use to
 * reach the machine. The desktop address stays with {@link DESKTOP_ROUTE}.
 */
const FRAME_ROUTE = '/api/plugins/omd-sandbox-vm/frame'

/**
 * How long one captured frame is reused. A card polls its machine faster than a
 * guest can usefully be asked for pictures, and every capture is a process
 * launch inside the guest, so a poll joins the frame already in hand.
 */
const FRAME_CACHE_MS = 1_500

/** How often a watched machine is re-read; a machine changes on a human timescale. */
const WATCH_POLL_MS = 2_000

/** Deployment settings for the machine provider. */
export interface Config {
  /** The `orbctl` binary. A different install path is the only reason to change it. */
  orbctlPath: string
  /** Image a new machine is created from, as `distro` or `distro:version`. */
  image: string
  /** Virtual CPUs for a new machine. */
  cpus: number
  /** Memory for a new machine, in orbctl's units: `4G`, or MiB as `4096M`. */
  memory: string
  /**
   * Machines whose name starts with this belong to this deployment, and are the
   * ones `vm://` lists and `list()` returns.
   */
  namePrefix: string
  /** Guest path the workspace is mounted at. Fixed when a machine is created. */
  guestWorkspacePath: string
  /** Whether a provisioned machine gets a guest desktop and a browser bridge. */
  desktop: boolean
  /**
   * Port the guest bridge listens on. The wrench's route puts it into the
   * address it mints, so nobody types it and no credential is derived from it.
   */
  desktopPort: number
  /**
   * Budget from `create` to the first command a machine accepts, and separately
   * for one desktop bootstrap. A first bootstrap pulls the desktop stack, the
   * dev tooling and a browser, so it is the slow path on a fresh machine.
   */
  readyTimeoutMs: number
  /** Default deadline for a guest command that names none. */
  execTimeoutMs: number
  /**
   * Destroy the machines this process created when the plugin unloads. Off by
   * default: a plugin reload during a long run should not delete the machine
   * the run is using, and a leftover machine is named and visible in `vm://`.
   */
  disposeOnUnload: boolean
  /** Reclaim a machine after this long without a command or desktop open; 12 h by default. 0 keeps it. */
  idleTimeoutMs: number
  /** How often the idle sweep runs, in milliseconds; 10 min by default. */
  idleSweepMs: number
}

/** Schemastery configuration for the plugin entry. */
export const Config: z<Config> = z.object({
  orbctlPath: z.string().default('orbctl').description('The orbctl binary.'),
  image: z.string().default('ubuntu:24.04').description('Image a new machine is created from.'),
  cpus: z.number().step(1).min(1).default(4).description('Virtual CPUs for a new machine.'),
  memory: z.string().default('4G').description('Memory for a new machine, in orbctl units such as 4G or 4096M.'),
  namePrefix: z
    .string()
    .default('omd-sandbox-')
    .description('Machines whose name starts with this belong to this deployment.'),
  guestWorkspacePath: z
    .string()
    .default('/workspace')
    .description('Guest path the workspace is mounted at.'),
  desktop: z
    .boolean()
    .default(true)
    .description('Whether a provisioned machine gets a guest desktop and a browser bridge.'),
  desktopPort: z
    .number()
    .step(1)
    .min(1)
    .max(65_535)
    .default(6080)
    .description('Port the guest desktop bridge listens on.'),
  readyTimeoutMs: z
    .number()
    .step(1)
    .min(1_000)
    .default(300_000)
    .description('Budget from create to the first accepted command, and for one desktop bootstrap.'),
  execTimeoutMs: z
    .number()
    .step(1)
    .min(1_000)
    .default(120_000)
    .description('Default deadline for a guest command that names none.'),
  disposeOnUnload: z
    .boolean()
    .default(false)
    .description('Destroy the machines this process created when the plugin unloads.'),
  idleTimeoutMs: z
    .number()
    .step(1)
    .min(0)
    .default(43_200_000)
    .description('Reclaim a machine after this long without a command or desktop open, in milliseconds; 12 h by default. 0 keeps it.'),
  idleSweepMs: z
    .number()
    .step(1)
    .min(1_000)
    .default(600_000)
    .description('How often the idle sweep runs, in milliseconds; 10 min by default.'),
})

/**
 * One machine as the document every `vm://` address returns: the field order
 * the README documents, with absent optional facts written as null so a reader
 * never has to tell "missing" from "no such field". `desktop` is whether a
 * human could be let in, not where: an address is a credential, and nothing in
 * a document carries one.
 * @param machine - the machine's snapshot.
 * @returns the JSON body for that address.
 */
function documentOf(machine: MachineSnapshot): Record<string, unknown> {
  return {
    name: machine.name,
    state: machine.state,
    workspacePath: machine.workspacePath,
    desktop: machine.desktop,
    cpus: machine.cpus ?? null,
    memory: machine.memoryMiB ?? null,
    image: machine.image,
  }
}

/**
 * Split an address remainder into its non-empty segments.
 * @param address - the remainder as written.
 * @returns the segments, with leading and trailing slashes dropped.
 */
function segments(address: string): string[] {
  return address.trim().replace(/^\/+/u, '').replace(/\/+$/u, '').split('/').filter(part => part !== '')
}

/**
 * Turn one machine's state changes into a pushed stream. The first line is the
 * state as it is now; every later line is a state that differs from the one
 * before it, so a reader sees a creation, a desktop coming up, and the machine
 * disappearing, without ever re-reading the address to find out.
 *
 * The poll runs on a timer this iterator owns. Aborting the caller's signal
 * ends the iteration and clears that timer; so does a consumer that breaks out.
 *
 * @param vm - the machine provider.
 * @param machine - machine name.
 * @param signal - the caller's cancellation.
 * @returns one JSON line per observed state.
 */
function stateStream(vm: SandboxVm, machine: string, signal: AbortSignal | undefined): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<string> {
      const queue: string[] = []
      let wake: (() => void) | undefined
      let done = signal?.aborted === true
      let last: SandboxState | undefined
      let polling = false
      const emit = (value: string): void => {
        if (done) return
        queue.push(value)
        wake?.()
        wake = undefined
      }
      const poll = async (): Promise<void> => {
        if (polling || done) return
        polling = true
        try {
          const snapshot = await vm.snapshot(machine)
          const state: SandboxState = snapshot?.state ?? 'absent'
          if (state === last) return
          last = state
          emit(`${JSON.stringify({ name: machine, state, at: new Date().toISOString() })}\n`)
        } catch {
          // A probe that failed says nothing about the machine. The next tick
          // reports whatever is true then, so a blip is not a state change.
        } finally {
          polling = false
        }
      }
      const timer = setInterval(() => { void poll() }, WATCH_POLL_MS)
      const abort = (): void => {
        done = true
        wake?.()
        wake = undefined
      }
      signal?.addEventListener('abort', abort, { once: true })
      void poll()
      try {
        while (!done) {
          const next = queue.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          const wait = Promise.withResolvers<void>()
          wake = wait.resolve
          await wait.promise
        }
        for (const line of queue) yield line
      } finally {
        clearInterval(timer)
        signal?.removeEventListener('abort', abort)
      }
    },
  }
}

/**
 * Build the `vm` source over one machine provider.
 * @param vm - the machine provider this entry published.
 * @returns the source the registry publishes.
 */
export function createVmSource(vm: SandboxVm): InternalSource {
  return {
    grammar: 'vm:// | vm://<machine> | vm://<machine>/desktop',
    description:
      'Isolated Linux machines: read the roster or one machine as a JSON document, ask where a desktop '
      + 'address comes from, and watch a machine to be told when its state changes. A desktop itself is '
      + 'opened by a human from the Bot config wrench; no address and no credential appears here.',
    shorthand: true,
    live: true,
    async read(path, exec) {
      const parts = segments(path)
      const head = parts[0]
      if (head === undefined) return `${JSON.stringify((await vm.snapshots()).map(documentOf), null, 2)}\n`
      if (!MACHINE_NAME.test(head)) {
        throw new Error(`omd-sandbox-vm: "${head}" is not a machine name; read vm:// for the roster`)
      }
      const machine = await vm.snapshot(head)
      if (machine === undefined) {
        throw new Error(`omd-sandbox-vm: no machine named "${head}" exists on this host; read vm:// for the roster`)
      }
      if (parts.length === 1) return `${JSON.stringify(documentOf(machine), null, 2)}\n`
      if (parts.length === 2 && parts[1] === 'desktop') {
        // The address a desktop is opened with is a password, so it is not a
        // document: a script is told where to ask for one, and the model is
        // told to leave it to the human whose click mints it.
        if (exec.origin !== 'script' && exec.origin !== 'human') {
          throw new Error(
            'omd-sandbox-vm: a desktop is opened by a human from the Bot config wrench, never read; '
            + `vm://${head} says whether one could be (${machine.desktop ? 'desktop: true' : 'desktop: false'})`,
          )
        }
        return `Desktop addresses are minted per human click: GET ${DESKTOP_ROUTE}?name=${head} answers `
          + '{ name, url, expiresAt } with a one-time password embedded in the URL.\n'
      }
      throw new Error(`omd-sandbox-vm: vm://${head}${parts.slice(1).map(part => `/${part}`).join('')} is not an address this source has`)
    },
    watch(path, exec) {
      const parts = segments(path)
      const machine = parts[0]
      if (machine === undefined || !MACHINE_NAME.test(machine) || parts.length !== 1) {
        throw new Error('omd-sandbox-vm: watch one machine, as vm://<machine>')
      }
      return stateStream(vm, machine, exec.signal)
    },
  }
}

/** The part of `ctx.connection.fetch` this plugin registers its route on. */
interface ConnectionFetchFace {
  register(route: {
    path: string
    methods: string[]
    requestBody: string
    fetch: (request: Request) => Promise<Response>
  }): () => void
}

/** One capture of one machine's desktop, shared by whoever asks while it is current. */
interface FrameEntry {
  /** When the capture started, which is what {@link FRAME_CACHE_MS} measures. */
  readonly at: number
  /** Whether it has settled; a capture still running is always joined. */
  settled: boolean
  /** The capture itself, resolved to the PNG bytes. */
  readonly frame: Promise<Buffer>
}

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

/**
 * A PNG body. A `Response` body has to sit on an `ArrayBuffer`, and a buffer
 * from `Buffer.from` is a view into a shared pool, so the bytes are re-viewed
 * rather than copied.
 * @param frame - the PNG bytes.
 * @returns the response, uncached because the picture is live.
 */
function png(frame: Buffer): Response {
  const bytes = frame.buffer instanceof ArrayBuffer
    ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
    : new Uint8Array(frame)
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
}

/**
 * Serve the one address a human's browser opens a desktop with.
 *
 * The whole trust boundary sits in where this is registered: `/api` answers
 * only to the launch-token cookie, which is the human's browser, so the model
 * has no path to it. A name outside the deployment is a 404, and a machine
 * whose desktop cannot be handed out is a 409, because both are the route's
 * own answers rather than a failure behind it.
 * @param request - the browser's request.
 * @param vm - the machine provider.
 * @param namePrefix - names outside this prefix are not this deployment's.
 * @returns the minted address, or a short JSON error.
 */
async function desktopRequest(request: Request, vm: SandboxVm, namePrefix: string): Promise<Response> {
  if (request.method !== 'GET') return failure(405, 'GET required')
  const name = (new URL(request.url).searchParams.get('name') ?? '').trim()
  if (name === '') return failure(400, `missing "name": GET ${DESKTOP_ROUTE}?name=<machine>`)
  if (!MACHINE_NAME.test(name) || !name.startsWith(namePrefix)) {
    return failure(404, `no machine named ${JSON.stringify(name)} belongs to this deployment`)
  }
  try {
    return Response.json(await vm.openDesktop(name), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof DesktopUnavailable) {
      return failure(error.reason === 'unknown-machine' ? 404 : 409, message)
    }
    return failure(502, message)
  }
}

/**
 * Serve one frame of a machine's desktop as PNG.
 *
 * The whole point of the route is what it does not hand out: a caller gets a
 * picture, never an address and never a password, so anything trusted enough to
 * render a card is trusted enough to render this. Every status is the route's
 * own judgement — 404 for a name outside the deployment or one no machine
 * carries, 409 for a machine that runs no display, 502 for a capture that ran
 * and failed — so a caller can tell "not here" from "broken".
 * @param request - the browser's request.
 * @param frameOf - one machine's frame, cached and shared between pollers.
 * @param namePrefix - names outside this prefix are not this deployment's.
 * @returns the PNG bytes, or a short JSON error.
 */
async function frameRequest(
  request: Request,
  frameOf: (name: string) => Promise<Buffer>,
  namePrefix: string,
): Promise<Response> {
  if (request.method !== 'GET') return failure(405, 'GET required')
  const name = (new URL(request.url).searchParams.get('name') ?? '').trim()
  if (name === '') return failure(400, `missing "name": GET ${FRAME_ROUTE}?name=<machine>`)
  if (!MACHINE_NAME.test(name) || !name.startsWith(namePrefix)) {
    return failure(404, `no machine named ${JSON.stringify(name)} belongs to this deployment`)
  }
  try {
    return png(await frameOf(name))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof DesktopUnavailable) {
      return failure(error.reason === 'unknown-machine' ? 404 : 409, message)
    }
    return failure(502, message)
  }
}

/**
 * Validate the deployment settings, then publish `ctx.sandboxVm` and register
 * the `vm` source.
 * @param ctx - the entry fiber's context.
 * @param config - deployment settings for this profile.
 * @throws when a setting cannot produce a machine this package could address
 * or create.
 */
export function apply(ctx: Context, config: Config): void {
  if (!MACHINE_NAME.test(`${config.namePrefix}0`)) {
    throw new Error(`omd-sandbox-vm: namePrefix "${config.namePrefix}" must produce names matching ${String(MACHINE_NAME)}`)
  }
  if (!config.guestWorkspacePath.startsWith('/')) {
    throw new Error(`omd-sandbox-vm: guestWorkspacePath "${config.guestWorkspacePath}" must be an absolute guest path`)
  }
  if (!/^\d+(?:\.\d+)?[MG]$/u.test(config.memory)) {
    throw new Error(`omd-sandbox-vm: memory "${config.memory}" must be orbctl units, such as 4G or 4096M`)
  }
  if (config.image.trim() === '') throw new Error('omd-sandbox-vm: image must name an image')

  const vm = createSandboxVm({
    orbctlPath: config.orbctlPath,
    image: config.image,
    cpus: config.cpus,
    memory: config.memory,
    namePrefix: config.namePrefix,
    guestWorkspacePath: config.guestWorkspacePath,
    desktop: config.desktop,
    desktopPort: config.desktopPort,
    readyTimeoutMs: config.readyTimeoutMs,
    execTimeoutMs: config.execTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    activityFile: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'data', 'omd-sandbox-vm', 'activity.json'),
    onWarn: message => ctx.logger.warn(message),
  })
  ctx.provide('sandboxVm', vm)

  const disposeSource = ctx.internalPaths.register(SOURCE, createVmSource(vm))
  ctx.effect(() => () => disposeSource(), 'omd-sandbox-vm: vm source')

  /** One capture per machine: every caller inside the window joins it. */
  const frames = new Map<string, FrameEntry>()

  /**
   * The frame a caller may reuse: the one in hand while it is younger than
   * {@link FRAME_CACHE_MS}, or the one still running. A failed capture is
   * forgotten, so the next poll asks the guest again instead of replaying an
   * error until the window turns over.
   * @param name - machine name.
   * @returns the frame, or the capture that is producing it.
   */
  function frameOf(name: string): Promise<Buffer> {
    const cached = frames.get(name)
    if (cached !== undefined && (!cached.settled || Date.now() - cached.at < FRAME_CACHE_MS)) return cached.frame
    const entry: FrameEntry = { at: Date.now(), settled: false, frame: vm.captureFrame(name) }
    entry.frame.then(
      () => { entry.settled = true },
      () => {
        entry.settled = true
        if (frames.get(name) === entry) frames.delete(name)
      },
    )
    frames.set(name, entry)
    return entry.frame
  }

  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as { fetch?: ConnectionFetchFace } | undefined
    if (connection?.fetch === undefined) return
    const fetch = connection.fetch
    scope.effect(() => {
      const releaseDesktop = fetch.register({
        path: DESKTOP_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request: Request): Promise<Response> => desktopRequest(request, vm, config.namePrefix),
      })
      const releaseFrame = fetch.register({
        path: FRAME_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request: Request): Promise<Response> => frameRequest(request, frameOf, config.namePrefix),
      })
      return () => {
        releaseDesktop()
        releaseFrame()
      }
    }, 'omd-sandbox-vm: routes')
  })

  if (config.idleTimeoutMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void vm.sweepIdle().catch((error: unknown) => {
          ctx.logger.warn('omd-sandbox-vm: the idle sweep failed: %o', error)
        })
      }, config.idleSweepMs)
      timer.unref()
      return () => clearInterval(timer)
    }, 'omd-sandbox-vm: idle sweep')
  }

  if (config.disposeOnUnload) {
    ctx.effect(() => () => {
      vm.disposeOwned().catch((error: unknown) => {
        ctx.logger.warn('omd-sandbox-vm: disposing machines on unload failed: %o', error)
      })
    }, 'omd-sandbox-vm: machines')
  }
}
