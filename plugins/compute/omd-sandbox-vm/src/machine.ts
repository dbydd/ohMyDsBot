/**
 * `SandboxService` over OrbStack's `orbctl`: one isolated ARM64 Linux machine
 * per sandbox, a host directory mounted into it, and a guest desktop a human
 * opens in a browser.
 *
 * The layer split is the seam's, and it is why `exec` takes a shell command and
 * nothing else: the agent, its model and its session stay on the host, and only
 * command execution and the desktop cross into the machine. Nothing in this
 * module decides what runs.
 *
 * OrbStack facts that shape the code, measured on this host:
 *
 * - `--isolated` disables default file sharing, so the workspace is a per
 *   machine `--mount` given at creation and never afterwards.
 * - `orbctl run` has no `--` separator; the command is simply the arguments
 *   after the flags. A command is therefore always `/bin/sh -c <string>`,
 *   which keeps the seam's "shell command" meaning intact.
 * - `orbctl run` on a stopped machine starts it, so readiness is a poll of
 *   `orbctl run -m <name> true` rather than a state field.
 *
 * The desktop's credential is this module's own fact, and a human's: one
 * password per machine is minted here, hashed into the guest by `x11vnc`
 * itself, held only in this process's memory, and handed out only as a
 * short-lived noVNC address minted on a human click. `vm://` names no
 * credential, and no setting configures one.
 *
 * A frame of that desktop crosses a different way: {@link SandboxVm.captureFrame}
 * takes a picture inside the guest through the same `exec` seam, so it needs no
 * password and returns none — anybody may see the room, only a human gets the key.
 *
 * @module omd-sandbox-vm/machine
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { connect as connectTcp } from 'node:net'
import { dirname, resolve as resolvePath } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OrbctlError, runOrbctl, tryOrbctl } from './orbctl.ts'
import type {
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxRequest,
  SandboxService,
  SandboxState,
} from './types.ts'

/** Machine names this package accepts and orbctl can address, and a DNS label as well. */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u

/** Ceiling on the stdout of one listing. */
const LIST_MAX_BYTES = 4_194_304

/** Ceiling on the streams one guest command may capture. */
const EXEC_MAX_BYTES = 8_388_608

/** Deadline for an `orbctl` call this package makes for itself: list and delete. */
const CONTROL_TIMEOUT_MS = 60_000

/** Deadline for one readiness probe, so a wedged call cannot eat the whole budget. */
const PROBE_TIMEOUT_MS = 10_000

/** How long the host waits for the guest bridge to answer one probe. */
const BRIDGE_PROBE_MS = 2_000

/** Port `x11vnc` listens on inside the guest, which the bridge forwards to. */
const VNC_PORT = 5900

/** How long the host waits for the guest's VNC port to accept a connection. */
const VNC_PROBE_MS = 1_000

/** How often a machine that is not answering yet is probed again. */
const READY_POLL_MS = 250

/** Directory and file holding the hashed VNC password, both root-owned. */
const PASSWORD_DIR = '/root/.omd-vnc'
const PASSWORD_FILE = `${PASSWORD_DIR}/passwd`

/** Guest variable that carries one fresh password to the hashing step. */
const PASSWORD_ENV = 'OMD_VNC_PASSWORD'

/** Deadline for installing one password: a `sudo` and `x11vnc` round trip in the guest. */
const PASSWORD_TIMEOUT_MS = 30_000

/** Bytes of entropy in one password: 24 bytes is 32 URL-safe characters. */
const PASSWORD_BYTES = 24

/**
 * Guest exit status meaning "this machine runs no display". The capture script
 * says it in its own words, so a machine without a desktop is a state the host
 * can answer 409 for, distinct from a `scrot` that ran and failed.
 */
const NO_DISPLAY_EXIT = 9

/**
 * Deadline for one frame capture: the guest runs `scrot` against a 1280×800
 * display and base64-encodes the PNG, which is a fraction of a second of work.
 */
const FRAME_TIMEOUT_MS = 10_000

/**
 * How long a minted desktop address is accepted. A module constant, not a
 * setting: the window exists so a link cannot outlive the click that made it,
 * and nobody has to tune it.
 */
const TICKET_TTL_MS = 60_000

/** One armed revocation timer; nothing but `clearTimeout` reads it back. */
type TimerHandle = ReturnType<typeof setTimeout>

/** Deployment settings, already validated by the plugin entry. */
export interface SandboxVmSettings {
  /** The `orbctl` binary. */
  readonly orbctlPath: string
  /** Image reference passed to `orbctl create`. */
  readonly image: string
  /** Virtual CPUs for a new machine. */
  readonly cpus: number
  /** Memory for a new machine, in orbctl's units (`4G`, `4096M`). */
  readonly memory: string
  /** Machines whose name starts with this belong to this deployment. */
  readonly namePrefix: string
  /** Guest path the workspace is mounted at. */
  readonly guestWorkspacePath: string
  /** Whether to install and start the guest desktop. */
  readonly desktop: boolean
  /** Port the guest bridge listens on, and the port the host probes. */
  readonly desktopPort: number
  /** Budget from `create` to the first command a machine accepts, and for one desktop bootstrap. */
  readonly readyTimeoutMs: number
  /** Default deadline for a guest command that names none. */
  readonly execTimeoutMs: number
  /** Where a recoverable problem is reported without failing the call that hit it. */
  readonly onWarn?: (message: string) => void
  /**
   * Reclaim a machine that has run no command and opened no desktop for this
   * long, in milliseconds. `0` keeps machines until something else removes them.
   */
  readonly idleTimeoutMs?: number
  /**
   * File the per-machine last-activity clock is kept in, so a host restart does
   * not reset a machine's idle age. Omitted keeps the clock in memory only.
   */
  readonly activityFile?: string
}

/** Everything one machine says about itself. */
export interface MachineSnapshot {
  /** Machine name. */
  readonly name: string
  /** Whether it is up, up without a desktop, or gone. */
  readonly state: SandboxState
  /** Guest path its workspace is mounted at. */
  readonly workspacePath: string
  /**
   * Whether a human can be handed this machine's desktop: the bridge answers
   * and this process holds the password the guest will ask for. Never an
   * address and never a credential — the address is minted per click.
   */
  readonly desktop: boolean
  /** Virtual CPUs it was created with. */
  readonly cpus: number | undefined
  /** Memory it was created with, in MiB. */
  readonly memoryMiB: number | undefined
  /** Image it was created from, as `distro:version`. */
  readonly image: string
}

/** One minted desktop address, which is the only thing that opens a desktop. */
export interface DesktopAccess {
  /** Machine the address opens. */
  readonly name: string
  /** The noVNC page, with this ticket's password already in it. */
  readonly url: string
  /** When the address stops being accepted, in epoch milliseconds. */
  readonly expiresAt: number
}

/**
 * A desktop that cannot be handed to a human: no such machine, the desktop is
 * off, or the guest runs a server that would not consult the password. Kept
 * apart from a failed `orbctl` call so the host route can answer 404 or 409.
 */
export class DesktopUnavailable extends Error {
  /** Why the route must refuse, so it can answer 404 for a name and 409 for a state. */
  readonly reason: 'unknown-machine' | 'not-ready'

  constructor(message: string, reason: 'unknown-machine' | 'not-ready') {
    super(message)
    this.name = 'DesktopUnavailable'
    this.reason = reason
  }
}

/**
 * What this package publishes. `SandboxService` is the contract other packages
 * code against; the extra methods describe a machine for the `vm://` source,
 * and mint the address a human opens, without narrowing that contract.
 */
export interface SandboxVm extends SandboxService {
  /**
   * Describe one machine without creating anything.
   * @param name - machine name.
   * @returns the machine, or `undefined` when no machine carries that name.
   */
  snapshot(name: string): Promise<MachineSnapshot | undefined>
  /**
   * Describe every machine under the configured prefix.
   * @returns the machines, in the order orbctl lists them, newest first.
   */
  snapshots(): Promise<readonly MachineSnapshot[]>
  /**
   * Mint a fresh desktop address for one machine, revoking the previous one.
   *
   * Human-only by construction: the plugin entry is the only caller, and it
   * answers from a host route the model cannot reach. The password it returns
   * is a new one, hashed into the guest before the address is handed out, and
   * replaced again when the address expires.
   * @param name - machine name.
   * @returns the address, its password already embedded, and its deadline.
   * @throws {DesktopUnavailable} when the machine has no desktop to hand out.
   */
  openDesktop(name: string): Promise<DesktopAccess>
  /**
   * Capture one frame of a machine's desktop as PNG bytes.
   *
   * The picture is taken inside the guest against display `:99`, so it needs
   * neither the VNC password nor the bridge, and the bytes it returns are a
   * picture of the room rather than a way into it: unlike {@link openDesktop},
   * a surface that shows them hands out no credential.
   * @param name - machine name.
   * @returns the PNG bytes of one frame.
   * @throws {DesktopUnavailable} when the deployment has no desktop, no machine
   * carries that name, or the machine runs no display to capture.
   * @throws {Error} when the guest could not take or encode the frame.
   */
  captureFrame(name: string): Promise<Buffer>
  /**
   * Stop a machine without destroying it: the disk, the packages and the
   * workspace mount all survive, and {@link SandboxVm.start} brings it back.
   * Idempotent: a machine already stopped is not an error.
   * @param name - machine name.
   */
  stop(name: string): Promise<void>
  /**
   * Start a stopped machine.
   * @param name - machine name.
   */
  start(name: string): Promise<void>
  /**
   * Destroy every machine that has been idle past the configured window.
   * @param now - the moment to measure against; defaults to the wall clock.
   * @returns the names destroyed, in the order they were found.
   */
  sweepIdle(now?: number): Promise<readonly string[]>
  /**
   * Destroy every machine this object created, ignoring the ones already gone.
   * Backs the entry's `disposeOnUnload` option.
   */
  disposeOwned(): Promise<void>
}

/** The fields of `orbctl list -f json` this package reads. */
interface MachineRecord {
  readonly name: string
  readonly image?: { readonly distro?: string, readonly version?: string }
  readonly config?: {
    readonly cpu_limit?: number
    readonly memory_limit_mib?: number
    readonly mounts?: readonly { readonly source: string, readonly destination: string }[]
  }
  readonly state?: string
}

/**
 * The guest shell function that installs one password as `x11vnc`'s own hash.
 *
 * The file is root-owned and 0600, so the hash — which is as good as the
 * password to anyone who can read it — is not readable by the account the
 * agent runs commands as. `x11vnc -storepasswd` takes the password as an
 * argument, so the plaintext exists in one `sudo` process's argv inside the
 * guest for the duration of that call; it never reaches the guest's disk in
 * plaintext, never appears in this host's command lines (it travels through
 * `ORBENV`), and never leaves this process's memory on the host.
 *
 * The first block refuses when the guest's `x11vnc` was started without
 * `-rfbauth`: writing a password for a server that will not ask for one would
 * make an unprotected desktop look protected.
 *
 * It is a function rather than a script because two callers need it: a desktop
 * that is already serving takes a new password on its own, while a machine
 * being provisioned needs the password installed between the package install
 * and the first `x11vnc` start.
 *
 * @returns the shell function, defined and not yet called.
 */
function passwordFunction(): string {
  return `
install_password() {
  if pgrep -x x11vnc >/dev/null 2>&1; then
    args=$(tr '\\0' ' ' < "/proc/$(pgrep -x x11vnc | head -1)/cmdline" 2>/dev/null || true)
    case "$args" in
      *-rfbauth*) ;;
      *)
        echo 'x11vnc is already running without -rfbauth, so a password would not protect this desktop; delete the machine to get a protected one' >&2
        exit 3
        ;;
    esac
  fi
  sudo install -d -m 700 ${PASSWORD_DIR}
  sudo sh -c 'umask 077; x11vnc -storepasswd "$1" "$2"' sh "\${${PASSWORD_ENV}}" ${PASSWORD_FILE}
  sudo chown root:root ${PASSWORD_FILE}
  sudo chmod 600 ${PASSWORD_FILE}
}
`.trim()
}

/** The guest script that installs one password on a desktop already serving. */
function passwordScript(): string {
  return `set -eu
${passwordFunction()}
install_password`.trim()
}

/**
 * The guest script that gives a machine both the working set an agent needs and
 * a desktop a human can watch, whatever the machine was before.
 *
 * Idempotent in both directions: packages are installed only when one is
 * missing, and each daemon is started only when it is not already running, so
 * re-provisioning a live machine leaves a working bridge alone while a rebooted
 * one gets its stack back. The working set is `git curl ca-certificates python3
 * python3-pip build-essential` in the same apt run as the desktop stack, and
 * the browser needs its own source: on Ubuntu 24.04 `firefox` and
 * `chromium-browser` are snap stubs and the image runs no snapd, so the browser
 * comes from Mozilla's apt repository pinned above the stub, while Debian
 * installs its own `chromium`. Whichever binary then answers `--version` is
 * written into the openbox root menu, so a machine with a desktop is one where
 * a browser is reachable by a right-click. `x11vnc` is started against the password file
 * {@link passwordScript} wrote, and refuses to start without one: a desktop
 * nobody can authenticate to is not a desktop this module reports. Every daemon
 * is detached with `setsid` and reads no stdin, because `orbctl run` returns
 * only when its command's process group is done with it. The last step proves
 * the bridge answers from inside the guest, so a failure is reported as a
 * failed command instead of a silent absence.
 *
 * @param port - port the bridge listens on.
 * @returns the script, run by the guest's `/bin/sh`.
 */
function desktopBootstrap(port: number): string {
  return `
set -eu
${passwordFunction()}
missing=''
for tool in git curl python3 pip3 gcc; do
  command -v "$tool" >/dev/null 2>&1 || missing=yes
done
[ -f /etc/ssl/certs/ca-certificates.crt ] || missing=yes
for tool in Xvfb x11vnc websockify openbox xterm scrot; do
  command -v "$tool" >/dev/null 2>&1 || missing=yes
done
[ -f /usr/share/novnc/vnc.html ] || missing=yes
if [ -n "$missing" ]; then
  sudo apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xvfb x11vnc novnc websockify openbox xterm scrot git curl ca-certificates python3 python3-pip build-essential
fi
# A snap stub answers command -v and then fails to run, so presence is not
# evidence of a browser: --version is, and it needs no display.
runs_browser() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 30 "$1" --version >/dev/null 2>&1
  else
    "$1" --version >/dev/null 2>&1
  fi
}
browser=''
find_browser() {
  for candidate in google-chrome chromium firefox firefox-esr; do
    if command -v "$candidate" >/dev/null 2>&1 && runs_browser "$candidate"; then
      browser="$candidate"
      break
    fi
  done
}
find_browser
if [ -z "$browser" ]; then
  # Ubuntu 24.04 carries firefox and chromium-browser as snap stubs and this
  # image runs no snapd, so those names install a launcher with no browser
  # behind it. Mozilla's own apt repository, pinned above the stub, is a real
  # .deb; Debian needs none of that and takes its own chromium.
  if grep -qs '^ID=ubuntu' /etc/os-release; then
    sudo install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg | sudo tee /etc/apt/keyrings/packages.mozilla.org.asc >/dev/null
    echo 'deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main' | sudo tee /etc/apt/sources.list.d/mozilla.list >/dev/null
    printf 'Package: *\\nPin: origin packages.mozilla.org\\nPin-Priority: 1000\\n' | sudo tee /etc/apt/preferences.d/mozilla >/dev/null
    sudo apt-get update -qq
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq firefox || true
  else
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends chromium || true
  fi
  find_browser
  if [ -z "$browser" ]; then
    echo 'no web browser could be installed in this image; the guest desktop offers none' >&2
  fi
fi
install_password
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  rm -f /tmp/.X11-unix/X99
  setsid nohup Xvfb :99 -screen 0 1280x800x24 >/tmp/omd-desktop-xvfb.log 2>&1 </dev/null &
  waited=0
  while [ ! -S /tmp/.X11-unix/X99 ]; do
    waited=$((waited + 1))
    if [ "$waited" -gt 50 ]; then
      echo 'Xvfb did not open display :99; see /tmp/omd-desktop-xvfb.log' >&2
      exit 1
    fi
    sleep 0.2
  done
fi
# Only when the account has no menu of its own: an existing menu is someone's
# customization and is not ours to overwrite.
if [ -n "$browser" ] && [ ! -f "$HOME/.config/openbox/menu.xml" ]; then
  mkdir -p "$HOME/.config/openbox"
  cat > "$HOME/.config/openbox/menu.xml" <<MENU
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="desktop">
    <item label="Browser"><action name="Execute"><execute>$browser</execute></action></item>
    <item label="Terminal"><action name="Execute"><execute>xterm</execute></action></item>
  </menu>
</openbox_menu>
MENU
fi
if ! pgrep -x openbox >/dev/null 2>&1; then
  setsid nohup env DISPLAY=:99 openbox >/tmp/omd-desktop-openbox.log 2>&1 </dev/null &
fi
if ! pgrep -x x11vnc >/dev/null 2>&1; then
  # The password file lives under /root, which this account cannot list, so the
  # existence probe needs the same sudo that wrote the file.
  if ! sudo test -f ${PASSWORD_FILE}; then
    echo 'no hashed VNC password at ${PASSWORD_FILE}; refusing to start a desktop that asks for none' >&2
    exit 4
  fi
  # x11vnc runs as root so it can read that file, and it reads it for each
  # connection rather than once at startup — which is what lets a minted
  # password take effect without restarting the server or dropping a viewer.
  # -noshm is required: MIT-SHM segments belong to the account that started
  # Xvfb, so a root client attaching to them is refused with X BadAccess.
  sudo sh -c 'setsid nohup x11vnc -display :99 -forever -rfbauth ${PASSWORD_FILE} -noshm -shared -rfbport 5900 >/tmp/omd-desktop-x11vnc.log 2>&1 </dev/null &'
fi
# A bridge with no VNC server behind it answers /vnc.html and then fails every
# connection, so a desktop the code reports has to have the server running.
waited=0
until pgrep -x x11vnc >/dev/null 2>&1; do
  waited=$((waited + 1))
  if [ "$waited" -gt 50 ]; then
    echo 'x11vnc is not running; see /tmp/omd-desktop-x11vnc.log' >&2
    sudo cat /tmp/omd-desktop-x11vnc.log >&2 || true
    exit 5
  fi
  sleep 0.2
done
# The bridge is judged by whether it answers, not by whether a process is
# named: a command line is the wrong evidence, because this very script
# contains it.
if ! curl -fsS -o /dev/null "http://127.0.0.1:${port}/vnc.html" 2>/dev/null; then
  setsid nohup websockify --web /usr/share/novnc ${port} localhost:5900 >/tmp/omd-desktop-websockify.log 2>&1 </dev/null &
fi
waited=0
until curl -fsS -o /dev/null "http://127.0.0.1:${port}/vnc.html" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 50 ]; then
    echo 'the desktop bridge did not answer on port ${port}; see /tmp/omd-desktop-*.log' >&2
    exit 1
  fi
  sleep 0.2
done
echo desktop-ready
`.trim()
}

/**
 * The guest script that encodes one frame of display `:99` as base64.
 *
 * `scrot` grabs the X server the desktop already runs, so nothing here touches
 * the VNC password or the bridge: a picture of the desktop is not a way into
 * it. The display check comes first so a machine with no desktop is reported as
 * {@link NO_DISPLAY_EXIT}, which the host turns into a state rather than a
 * fault. `set -e` matters: a `scrot` that failed must not fall through to
 * encoding the previous frame still sitting in `/tmp`.
 * @returns the script, run by the guest's `/bin/sh`.
 */
function frameScript(): string {
  return `
set -eu
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  echo 'no Xvfb is running, so there is no display :99 to capture' >&2
  exit ${NO_DISPLAY_EXIT}
fi
DISPLAY=:99 scrot -o /tmp/omd-snap.png
base64 -w0 /tmp/omd-snap.png
`.trim()
}

/**
 * Build the machine provider. It holds three pieces of memory and nothing
 * else: the guest workspace of each machine it has described, so `exec` needs
 * no second orbctl call; the names it created, for `disposeOwned`; and the
 * desktop password of each machine it provisioned, which is the one thing here
 * no caller can read.
 * @param settings - validated deployment settings.
 * @returns the service published as `ctx.sandboxVm`.
 */
export function createSandboxVm(settings: SandboxVmSettings): SandboxVm {
  const workspaces = new Map<string, string>()
  const created = new Set<string>()
  /** The password each machine's `x11vnc` currently asks for. */
  const secrets = new Map<string, string>()
  /** The timer that revokes each machine's outstanding desktop address. */
  const revocations = new Map<string, TimerHandle>()
  /**
   * When each machine last ran a command or opened a desktop. OrbStack reports
   * no creation time, so this clock is the only idle evidence there is; it is
   * mirrored to {@link SandboxVmSettings.activityFile} so a restart does not
   * hand every machine a fresh window.
   */
  const lastActivity = new Map<string, number>()
  /** Serialises writes of the activity file; the newest snapshot wins. */
  let activityWrite: Promise<void> = Promise.resolve()
  let activityLoaded = false

  /** Read the persisted clock once, tolerating an absent or unreadable file. */
  function loadActivity(): void {
    if (activityLoaded || settings.activityFile === undefined) return
    activityLoaded = true
    void readFile(settings.activityFile, 'utf8')
      .then(text => {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
        for (const [name, at] of Object.entries(parsed)) {
          if (typeof at === 'number' && Number.isFinite(at)) lastActivity.set(name, at)
        }
      })
      .catch(() => {
        // A missing clock is a first run, and a corrupt one is no worse than one:
        // every machine starts with the window the caller configured.
      })
  }

  /** Persist the clock, one write at a time; a failure is a warning, not a fault. */
  function saveActivity(): void {
    if (settings.activityFile === undefined) return
    const file = settings.activityFile
    const snapshot = JSON.stringify(Object.fromEntries(lastActivity), null, 0)
    activityWrite = activityWrite
      .then(() => mkdir(dirname(file), { recursive: true }))
      .then(() => writeFile(file, snapshot, 'utf8'))
      .catch((error: unknown) => {
        settings.onWarn?.(`omd-sandbox-vm: the activity clock was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`)
      })
  }

  /** Record that one machine was used just now. */
  function touch(name: string, now: number = Date.now()): void {
    loadActivity()
    lastActivity.set(name, now)
    saveActivity()
  }

  /** The bridge address a machine with a desktop answers on. */
  function bridgeUrl(name: string): string {
    return `http://${name}.orb.local:${settings.desktopPort}/vnc.html`
  }

  /** One fresh password: 32 URL-safe characters, so it survives a query string. */
  function newPassword(): string {
    return randomBytes(PASSWORD_BYTES).toString('base64url')
  }

  /**
   * The environment one `orbctl run` needs for the guest to see a variable.
   * `orbctl` forwards only the names listed in `ORBENV`, which is why the
   * password never has to appear in an argument list on this host.
   * @param additions - variables for the guest.
   * @returns the environment for the call, or `undefined` when there is none.
   */
  function guestEnv(additions: Readonly<Record<string, string>>): Record<string, string> | undefined {
    const names = Object.keys(additions)
    if (names.length === 0) return undefined
    return {
      ...additions,
      ORBENV: [...new Set([
        ...(process.env.ORBENV ?? '').split(':').filter(entry => entry !== ''),
        ...names,
      ])].join(':'),
    }
  }

  /** Whether the guest's browser bridge answers HTTP. */
  async function bridgeAnswers(name: string): Promise<boolean> {
    try {
      const response = await fetch(bridgeUrl(name), { signal: AbortSignal.timeout(BRIDGE_PROBE_MS) })
      return response.ok
    } catch {
      // A machine that does not answer is a state to report, not a failure.
      return false
    }
  }

  /**
   * Whether the guest's VNC server accepts a connection.
   *
   * The bridge alone is not evidence: `websockify` serves `/vnc.html` whether
   * or not anything listens behind it, so a desktop with a dead `x11vnc` used
   * to look ready and then fail every viewer.
   * @param name - machine name.
   * @returns true when the forwarded VNC port accepts a connection.
   */
  function vncListens(name: string): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const socket = connectTcp({ host: `${name}.orb.local`, port: VNC_PORT })
    const finish = (listening: boolean): void => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(VNC_PROBE_MS, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => finish(true))
    return promise
  }

  /**
   * Make one password the password the guest asks for.
   *
   * `x11vnc` reads its password file for each connection rather than once at
   * startup, which is what lets a running desktop take a new password without
   * restarting the server and without disturbing a human already watching it.
   * @param name - machine name.
   * @param secret - the password to install.
   * @throws {DesktopUnavailable} when the guest could not install it, or its
   * running server would not ask for it.
   */
  async function installPassword(name: string, secret: string): Promise<void> {
    const result = await tryOrbctl({
      orbctlPath: settings.orbctlPath,
      argv: ['run', '-m', name, '/bin/sh', '-c', passwordScript()],
      timeoutMs: PASSWORD_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BYTES,
      env: guestEnv({ [PASSWORD_ENV]: secret }),
    })
    if (result.outcome === 'exited' && result.code === 0) return
    const ending = result.outcome === 'exited' ? `exit ${String(result.code)}` : result.outcome
    throw new DesktopUnavailable(
      `omd-sandbox-vm: "${name}" did not accept a password (${ending}): ${result.stderr.trim() || result.stdout.trim()}`,
      'not-ready',
    )
  }

  /** Replace the outstanding address's password, so that address stops working. */
  async function revoke(name: string): Promise<void> {
    if (!secrets.has(name)) return
    const secret = newPassword()
    try {
      await installPassword(name, secret)
      secrets.set(name, secret)
    } catch (error) {
      // Keeping the old password is the honest state here: the address that
      // was handed out may still be accepted, and the warning says so.
      settings.onWarn?.(
        `omd-sandbox-vm: could not revoke the desktop address of "${name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  /** Arm the revocation that makes one minted address stop being accepted. */
  function scheduleRevocation(name: string): void {
    clearTimeout(revocations.get(name))
    const timer = setTimeout(() => {
      revocations.delete(name)
      void revoke(name)
    }, TICKET_TTL_MS)
    timer.unref()
    revocations.set(name, timer)
  }

  async function records(): Promise<readonly MachineRecord[]> {
    const text = await runOrbctl({
      orbctlPath: settings.orbctlPath,
      argv: ['list', '-f', 'json'],
      timeoutMs: CONTROL_TIMEOUT_MS,
      maxBuffer: LIST_MAX_BYTES,
    })
    if (text.trim() === '') return []
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) {
      throw new Error('omd-sandbox-vm: orbctl list -f json did not answer with an array')
    }
    return parsed as MachineRecord[]
  }

  async function recordOf(name: string): Promise<MachineRecord | undefined> {
    return (await records()).find(record => record.name === name)
  }

  async function snapshotOf(record: MachineRecord): Promise<MachineSnapshot> {
    const hosted = record.config?.mounts?.find(mount => mount.destination === settings.guestWorkspacePath)?.destination
    const workspacePath = hosted ?? record.config?.mounts?.[0]?.destination ?? settings.guestWorkspacePath
    workspaces.set(record.name, workspacePath)
    // A desktop is worth reporting only when a human could actually be let in:
    // the bridge answers, the server behind it listens, and this process holds
    // the password it will ask for.
    const desktop = settings.desktop
      && record.state === 'running'
      && secrets.has(record.name)
      && await bridgeAnswers(record.name)
      && await vncListens(record.name)
    const image = record.image
    return {
      name: record.name,
      state: desktop || !settings.desktop ? 'ready' : 'ready-no-desktop',
      workspacePath,
      desktop,
      cpus: record.config?.cpu_limit,
      memoryMiB: record.config?.memory_limit_mib,
      image: image?.distro === undefined || image.version === undefined ? settings.image : `${image.distro}:${image.version}`,
    }
  }

  /** One machine, refusing a name no machine carries. */
  async function describe(name: string): Promise<MachineSnapshot> {
    const machine = await snapshot(name)
    if (machine === undefined) {
      throw new Error(`omd-sandbox-vm: no machine named "${name}" exists on this host; read vm:// for the roster`)
    }
    return machine
  }

  async function snapshot(name: string): Promise<MachineSnapshot | undefined> {
    const record = await recordOf(name)
    return record === undefined ? undefined : snapshotOf(record)
  }

  async function snapshotsOf(): Promise<readonly MachineSnapshot[]> {
    const mine = (await records()).filter(record => record.name.startsWith(settings.namePrefix))
    return Promise.all(mine.map(record => snapshotOf(record)))
  }

  /** Poll until the machine runs a command at all, which is what "ready" means here. */
  async function waitReachable(name: string): Promise<void> {
    const deadline = Date.now() + settings.readyTimeoutMs
    let last = 'it never answered'
    for (;;) {
      const probe = await tryOrbctl({
        orbctlPath: settings.orbctlPath,
        argv: ['run', '-m', name, 'true'],
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBuffer: LIST_MAX_BYTES,
      })
      if (probe.outcome === 'exited' && probe.code === 0) return
      last = probe.outcome === 'exited'
        ? probe.stderr.trim() === '' ? `exit ${String(probe.code)}` : probe.stderr.trim()
        : `the probe was ${probe.outcome}`
      if (Date.now() + READY_POLL_MS > deadline) {
        throw new Error(`omd-sandbox-vm: machine "${name}" did not accept a command within ${settings.readyTimeoutMs} ms: ${last}`)
      }
      await delay(READY_POLL_MS)
    }
  }

  /**
   * Bring the desktop up when it is not already up, and give it a password
   * this process keeps.
   *
   * Two paths, because a machine can be in two states. A desktop that already
   * answers only needs its password replaced, which is enough for one left
   * running by an earlier host process (`x11vnc` re-reads the file per
   * connection). Anything else runs the one idempotent guest script, which
   * installs the packages, takes the password from the environment, and starts
   * `x11vnc` against it — a server that was started without `-rfbauth` is
   * refused there rather than quietly reported as protected. Every failure is
   * reported instead of thrown: a machine without a desktop is still a usable
   * machine, and `state` says which one it is.
   */
  async function ensureDesktop(name: string): Promise<void> {
    if (!settings.desktop) return
    const secret = newPassword()
    if (await bridgeAnswers(name) && await vncListens(name)) {
      try {
        await installPassword(name, secret)
      } catch (error) {
        settings.onWarn?.(error instanceof Error ? error.message : String(error))
        return
      }
      secrets.set(name, secret)
      return
    }
    const result = await tryOrbctl({
      orbctlPath: settings.orbctlPath,
      argv: ['run', '-m', name, '/bin/sh', '-c', desktopBootstrap(settings.desktopPort)],
      timeoutMs: settings.readyTimeoutMs,
      maxBuffer: EXEC_MAX_BYTES,
      env: guestEnv({ [PASSWORD_ENV]: secret }),
    })
    if (!(result.outcome === 'exited' && result.code === 0)) {
      const ending = result.outcome === 'exited' ? `exit ${String(result.code)}` : result.outcome
      settings.onWarn?.(
        `omd-sandbox-vm: the desktop bootstrap on "${name}" ended with ${ending}: ${result.stderr.trim() || result.stdout.trim()}`,
      )
      return
    }
    secrets.set(name, secret)
  }

  async function execInGuest(name: string, command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    touch(name)
    const cwd = options.cwd ?? workspaces.get(name) ?? (await describe(name)).workspacePath
    const outcome = await tryOrbctl({
      orbctlPath: settings.orbctlPath,
      argv: ['run', '-m', name, '-w', cwd, '/bin/sh', '-c', command],
      timeoutMs: options.timeoutMs ?? settings.execTimeoutMs,
      maxBuffer: EXEC_MAX_BYTES,
      signal: options.signal,
      env: guestEnv(options.env ?? {}),
    })
    return {
      code: outcome.code ?? undefined,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      outcome: outcome.outcome,
    }
  }

  /** One machine in the seam's shape: a location a human may open, never a credential. */
  function sandboxOf(machine: MachineSnapshot): Sandbox {
    return {
      name: machine.name,
      workspacePath: machine.workspacePath,
      desktopUrl: machine.desktop ? bridgeUrl(machine.name) : undefined,
      state: machine.state,
    }
  }

  /**
   * Mint a desktop address: install a new password in the guest, then hand back
   * the noVNC page that carries it.
   *
   * This is the only way a desktop is opened, and it is a human's move — the
   * plugin entry exposes it from a route the model cannot reach. Each call
   * replaces the previous password, so an address cannot be kept alive by
   * copying it, and the one minted here is revoked when its timer fires.
   * @param name - machine name.
   * @returns the address, its password already embedded, and its deadline.
   * @throws {DesktopUnavailable} when there is no desktop to hand out.
   */
  async function openDesktop(name: string): Promise<DesktopAccess> {
    if (!settings.desktop) throw new DesktopUnavailable('omd-sandbox-vm: this deployment has no desktop', 'not-ready')
    const record = await recordOf(name)
    if (record === undefined) {
      throw new DesktopUnavailable(
        `omd-sandbox-vm: no machine named "${name}" exists on this host; read vm:// for the roster`,
        'unknown-machine',
      )
    }
    if (!await bridgeAnswers(name)) {
      throw new DesktopUnavailable(`omd-sandbox-vm: machine "${name}" has no bridge answering on port ${settings.desktopPort}`, 'not-ready')
    }
    if (!await vncListens(name)) {
      throw new DesktopUnavailable(`omd-sandbox-vm: machine "${name}" has no VNC server listening on port ${VNC_PORT}`, 'not-ready')
    }
    touch(name)
    const secret = newPassword()
    await installPassword(name, secret)
    secrets.set(name, secret)
    scheduleRevocation(name)
    return {
      name,
      url: `${bridgeUrl(name)}?password=${encodeURIComponent(secret)}&autoconnect=true&resize=remote`,
      expiresAt: Date.now() + TICKET_TTL_MS,
    }
  }

  /**
   * Take one frame of a machine's desktop as PNG bytes.
   *
   * The capture runs in the guest as an ordinary command, so it inherits the
   * same seam as everything else: the guest encodes the frame, only bytes cross
   * back. The work directory is `/tmp` rather than the workspace, because the
   * frame is nothing a caller keeps and the capture must not depend on a mount.
   * @param name - machine name.
   * @returns the PNG bytes of one frame.
   * @throws {DesktopUnavailable} when the deployment has no desktop, no machine
   * carries that name, or the machine runs no display.
   * @throws {Error} when the guest could not take or encode the frame.
   */
  async function captureFrame(name: string): Promise<Buffer> {
    if (!settings.desktop) {
      throw new DesktopUnavailable('omd-sandbox-vm: this deployment has no desktop', 'not-ready')
    }
    if (await recordOf(name) === undefined) {
      throw new DesktopUnavailable(
        `omd-sandbox-vm: no machine named "${name}" exists on this host; read vm:// for the roster`,
        'unknown-machine',
      )
    }
    const result = await execInGuest(name, frameScript(), { cwd: '/tmp', timeoutMs: FRAME_TIMEOUT_MS })
    if (result.outcome === 'exited' && result.code === NO_DISPLAY_EXIT) {
      throw new DesktopUnavailable(`omd-sandbox-vm: machine "${name}" runs no display on :99 to capture`, 'not-ready')
    }
    if (!(result.outcome === 'exited' && result.code === 0)) {
      const ending = result.outcome === 'exited' ? `exit ${String(result.code)}` : result.outcome
      throw new Error(
        `omd-sandbox-vm: capturing the desktop of "${name}" failed (${ending}): ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    return Buffer.from(result.stdout.trim(), 'base64')
  }

  async function disposeMachine(name: string): Promise<void> {
    clearTimeout(revocations.get(name))
    revocations.delete(name)
    secrets.delete(name)
    workspaces.delete(name)
    created.delete(name)
    if (lastActivity.delete(name)) saveActivity()
    if (await recordOf(name) === undefined) return
    const outcome = await tryOrbctl({
      orbctlPath: settings.orbctlPath,
      argv: ['delete', '--force', name],
      timeoutMs: CONTROL_TIMEOUT_MS,
      maxBuffer: LIST_MAX_BYTES,
    })
    // Another process deleting the same machine between the listing and the
    // delete is this call's own success, not a failure.
    if (outcome.outcome === 'exited' && (outcome.code === 0 || /machine not found/u.test(outcome.stderr))) return
    throw new OrbctlError(
      ['delete', '--force', name],
      outcome.code,
      outcome.stderr,
      outcome.outcome === 'exited' ? undefined : `the call was ${outcome.outcome}`,
    )
  }

  /**
   * Destroy every machine whose last command or desktop open is older than the
   * configured window.
   *
   * A machine this process has never seen used carries no clock entry; it is
   * stamped with `now` on its first sweep instead of being reaped, because the
   * absence of evidence is not evidence of twelve idle hours. That also covers
   * a machine created before this clock existed.
   * @param now - the moment to measure against.
   * @returns the names destroyed.
   */
  /**
   * Stop one machine, keeping its disk.
   *
   * `orbctl stop` is the cheap half of disposal: the guest disk, every package
   * installed in it and the workspace mount come back with {@link start}, which
   * is what makes a lease expiring different from a worker being closed.
   * @param name - machine name.
   */
  async function stopMachine(name: string): Promise<void> {
    if (await recordOf(name) === undefined) return
    const outcome = await tryOrbctl({
      orbctlPath: settings.orbctlPath,
      argv: ['stop', name],
      timeoutMs: CONTROL_TIMEOUT_MS,
      maxBuffer: LIST_MAX_BYTES,
    })
    if (outcome.outcome === 'exited' && outcome.code === 0) return
    if (outcome.outcome === 'exited' && /machine not found/u.test(outcome.stderr)) return
    throw new OrbctlError(
      ['stop', name],
      outcome.code,
      outcome.stderr,
      outcome.outcome === 'exited' ? undefined : `the call was ${outcome.outcome}`,
    )
  }

  /**
   * Start one machine again.
   * @param name - machine name.
   */
  async function startMachine(name: string): Promise<void> {
    if (await recordOf(name) === undefined) {
      throw new Error(`omd-sandbox-vm: no machine named "${name}" exists on this host`)
    }
    await runOrbctl({
      orbctlPath: settings.orbctlPath,
      argv: ['start', name],
      timeoutMs: settings.readyTimeoutMs,
      maxBuffer: LIST_MAX_BYTES,
    })
    await waitReachable(name)
    await ensureDesktop(name)
    touch(name)
  }

  async function sweepIdle(now: number = Date.now()): Promise<readonly string[]> {
    const window = settings.idleTimeoutMs ?? 0
    if (window <= 0) return []
    loadActivity()
    const reaped: string[] = []
    for (const record of await records()) {
      if (!record.name.startsWith(settings.namePrefix)) continue
      const seen = lastActivity.get(record.name)
      if (seen === undefined) {
        touch(record.name, now)
        continue
      }
      if (now - seen < window) continue
      try {
        await disposeMachine(record.name)
        reaped.push(record.name)
        settings.onWarn?.(
          `omd-sandbox-vm: reclaimed "${record.name}" after ${String(Math.round((now - seen) / 3_600_000))} h idle`,
        )
      } catch (error) {
        settings.onWarn?.(
          `omd-sandbox-vm: could not reclaim idle machine "${record.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    return reaped
  }

  return {
    async provision(request: SandboxRequest): Promise<Sandbox> {
      if (!MACHINE_NAME.test(request.name)) {
        throw new Error(`omd-sandbox-vm: machine name "${request.name}" must match ${String(MACHINE_NAME)}`)
      }
      if (!request.workspacePath.startsWith('/')) {
        throw new Error(`omd-sandbox-vm: workspacePath "${request.workspacePath}" must be absolute`)
      }
      await mkdir(request.workspacePath, { recursive: true })
      const host = await realpath(request.workspacePath).catch(() => resolvePath(request.workspacePath))

      const existing = await recordOf(request.name)
      const mounted = existing?.config?.mounts?.find(mount => mount.destination === settings.guestWorkspacePath)?.source
      if (existing === undefined) {
        await runOrbctl({
          orbctlPath: settings.orbctlPath,
          argv: [
            'create',
            '--isolated',
            '--arch',
            'arm64',
            '--cpus',
            String(settings.cpus),
            '--memory',
            settings.memory,
            '--mount',
            `${host}:${settings.guestWorkspacePath}`,
            settings.image,
            request.name,
          ],
          timeoutMs: settings.readyTimeoutMs,
          maxBuffer: LIST_MAX_BYTES,
        })
      } else {
        const mountedHost = mounted === undefined ? undefined : await realpath(mounted).catch(() => resolvePath(mounted))
        if (mountedHost !== host) {
          throw new Error(
            `omd-sandbox-vm: machine "${request.name}" already exists and mounts `
              + `${mounted === undefined ? `nothing at ${settings.guestWorkspacePath}` : `${mounted} at ${settings.guestWorkspacePath}`}`
              + `; it cannot be reused for ${host}. Delete it, or provision under another name.`,
          )
        }
      }

      await waitReachable(request.name)
      await ensureDesktop(request.name)
      created.add(request.name)
      touch(request.name)
      return sandboxOf(await describe(request.name))
    },

    exec: execInGuest,

    async inspect(name: string): Promise<Sandbox | undefined> {
      const record = await recordOf(name)
      if (record === undefined) return undefined
      return sandboxOf(await snapshotOf(record))
    },

    dispose: disposeMachine,

    async list(): Promise<readonly Sandbox[]> {
      return (await snapshotsOf()).map(sandboxOf)
    },

    snapshot,
    snapshots: snapshotsOf,
    openDesktop,
    captureFrame,
    stop: stopMachine,
    start: startMachine,
    sweepIdle,

    async disposeOwned(): Promise<void> {
      for (const name of [...created]) await disposeMachine(name)
    },
  }
}
