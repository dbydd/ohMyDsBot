# omd-sandbox-vm

Isolated ARM64 Linux machines for agent command execution, each with a guest
desktop a human can open in a browser and take over. It publishes
`ctx.sandboxVm` and the `vm://` internal paths.

Three things stay separate, and the seam says so: the **agent** runs on this
host with its model and its session; its **files** are a host directory; the
**machine** is where commands run and where the desktop lives. Nothing here
carries an agent, a session or a model, so a caller undecided about its work can
still call it.

A provisioned machine is one an agent can start working in without installing
anything: `git`, `curl`, `ca-certificates`, `python3` with `pip`, and
`build-essential`, plus an X desktop whose right-click menu opens a real
browser. The default image is `ubuntu:24.04`.

The desktop's credential is this module's own fact. It mints one password per
machine, hashes it into the guest with `x11vnc -storepasswd`, keeps the plaintext
only in this process's memory, and hands a fresh one out only as a short-lived
noVNC address that a human's click mints through the Bot config wrench. There is
no configuration field for it, no address and no password in any `vm://`
document, and no path back into the model's context: the route that mints the
address lives under `/api`, which answers only to the browser's launch-token
cookie. A picture of the same desktop crosses without the credential — taken
inside the guest, served as PNG — so a card can show the room while the key
stays with the click.

## What it owns

| method | does |
| --- | --- |
| `provision(request)` | Create or reuse the machine named in the request, wait until it accepts a command, bring the desktop up, and report its state. |
| `exec(name, command, options)` | Run one `/bin/sh -c` command inside the machine. Maps a non-zero exit to `exited` with its code, a deadline to `timeout`, and an aborted signal to `aborted`. |
| `inspect(name)` | The machine as it is now, or `undefined` when it does not exist. |
| `dispose(name)` | Delete the machine and everything in it. Idempotent. |
| `list()` | Every machine under the configured prefix, newest first. |
| `snapshot(name)`, `snapshots()` | What a machine reports about itself, `desktop` included, without creating anything. |
| `openDesktop(name)` | Mint a fresh desktop address for one machine, revoking the previous one. The plugin entry is its only caller, from the human's route. |
| `captureFrame(name)` | One PNG frame of the machine's desktop, taken inside the guest. No credential on either side of it. |

`SandboxState` is `ready` (commands and desktop both answer), `ready-no-desktop`
(the machine answers; the bridge does not), or `absent` (that machine is gone —
`inspect` reports it by returning `undefined`).

A machine is created with

```
orbctl create --isolated --arch arm64 --cpus <cpus> --memory <memory> \
  --mount <workspace>:/workspace <image> <name>
```

`--isolated` turns off default file sharing, which is why the workspace is a
per-machine `--mount` fixed at creation. Guest writes land in the host
directory directly, and a change set is read on the host without a collector.

`provision` is idempotent in the useful sense: an existing machine with the same
name and the same mount is reused, its desktop is repaired if it is missing and
left alone if it answers; an existing machine mounted somewhere else is an
error, not a silent reuse. Creation settings (`image`, `cpus`, `memory`) apply
when a machine is created — an existing machine keeps what it has.

## Configuration

| field | default | meaning |
| --- | --- | --- |
| `orbctlPath` | `orbctl` | The `orbctl` binary. |
| `image` | `ubuntu:24.04` | Image a new machine is created from. |
| `cpus` | `4` | Virtual CPUs for a new machine. |
| `memory` | `4G` | Memory for a new machine, in orbctl units (`4G`, `4096M`). |
| `namePrefix` | `omd-sandbox-` | Machines whose name starts with this belong to this deployment. |
| `guestWorkspacePath` | `/workspace` | Guest path the workspace is mounted at. |
| `desktop` | `true` | Whether a provisioned machine gets a guest desktop and a browser bridge. |
| `desktopPort` | `6080` | Port the guest bridge listens on. |
| `readyTimeoutMs` | `300000` | Budget from `create` to the first accepted command, and separately for one desktop bootstrap. The first bootstrap on a fresh machine pulls the desktop stack, the dev tooling and a browser. |
| `execTimeoutMs` | `120000` | Default deadline for a guest command that names none. |
| `disposeOnUnload` | `false` | Destroy the machines this process created when the plugin unloads. |

```yaml
- id: omd-sandbox-vm
  name: omd-sandbox-vm
  config:
    desktop: true
    desktopPort: 6080
```

`disposeOnUnload` is off by default: a plugin reload during a long run must not
delete the machine the run is using, and a machine left behind is named and
visible in `vm://`.

## Internal paths

Source name `vm`, shorthand on, read-only — there is no `write` and no `post`,
so nothing can be edited into a broken machine by a text write. Machines come
from `provision`.

| address | returns |
| --- | --- |
| `vm://` | Every machine under `namePrefix`, one JSON document each. |
| `vm://<machine>` | That machine: `name`, `state`, `workspacePath`, `desktop`, `cpus`, `memory`, `image`. |
| `vm://<machine>/desktop` | Where a desktop address comes from: one line naming the host route. Refused for a model read. |

```json
{
  "name": "omd-sandbox-selftest",
  "state": "ready",
  "workspacePath": "/workspace",
  "desktop": true,
  "cpus": 2,
  "memory": 2048,
  "image": "ubuntu:24.04"
}
```

`cpus`, `memory` and `image` are what orbctl reports the machine was created
with; `memory` is MiB, while the config field takes orbctl units. `desktop` is
whether a human could be let in — the bridge answers, `x11vnc` listens, and this
process holds the password it will ask for — and the optional creation facts are
`null` rather than absent, so a reader never has to tell "missing" from "no such
field". Reading a machine that does not exist throws; the roster always reads.

`vm://<machine>/desktop` exists so the address is discoverable without being
readable. A script is told `GET /api/plugins/omd-sandbox-vm/desktop?name=<machine>`
answers `{ name, url, expiresAt }`; a model read throws, because the address is
the credential and the route that mints it is the browser's channel.

`watch vm://<machine>` pushes one JSON line per observed state, starting with the
current one: `{"name":…,"state":"ready","at":"…"}`, then `ready-no-desktop` when
the bridge dies, then `absent` after `dispose`. The first line costs one
`orbctl list`; later lines come from a poll this iterator owns, and aborting the
caller's signal ends the iteration and clears that timer. A probe that fails
says nothing about the machine, so it is not reported as a state change.

## The desktop

`provision` runs one idempotent guest script when the desktop is not answering:
install `xvfb x11vnc novnc websockify openbox xterm scrot` plus the agent's
working set — `git curl ca-certificates python3 python3-pip build-essential` —
in a single apt run when a binary is missing, write the machine's password with
`x11vnc -storepasswd` into a root-owned 0600 file under `/root`, then start
whichever daemon is not running — `Xvfb :99`, `openbox`, `x11vnc -rfbauth <file>
-rfbport 5900`, and `websockify --web /usr/share/novnc <port> localhost:5900`.
`scrot` is there for the frame route, not for the human: it grabs display `:99`
directly, so a picture never goes near the password or the bridge. Tasks are
detached with `setsid` and read no stdin, because `orbctl run` returns only when
its command's process group is done with it. The last steps are a check that
`x11vnc` is running and a `curl` of `/vnc.html` from inside the guest, so a
half-started desktop is a failed command with a message instead of a silent
absence.

The browser is the one package that needs its own source. Ubuntu 24.04 carries
`firefox` and `chromium-browser` as snap stubs, and the image runs no `snapd`,
so installing either name yields a launcher with no browser behind it. The
guest therefore adds Mozilla's apt repository and pins it at priority 1000
(`/etc/apt/sources.list.d/mozilla.list`, `/etc/apt/preferences.d/mozilla`) and
installs `firefox` from there; on a Debian image, which ships none of those
stubs, it installs `chromium` instead. The browser is then chosen by behaviour,
not by name: `command -v` alone accepts a snap stub, so each of `google-chrome`,
`chromium`, `firefox` and `firefox-esr` has to answer `--version` before it
counts, which needs no display. The one that does is written into the openbox
root menu as `Browser`, beside `Terminal`, so a machine whose desktop answers is
one where a browser is reached by right-click and not only by typing a package
name into a shell. A browser that cannot be installed leaves the desktop working
and says so on stderr; it does not fail `provision`.

The first bootstrap on a fresh machine is the slow path — two apt
update-plus-install rounds, the second of them a browser — which is why
`readyTimeoutMs` defaults to 300 s.

`x11vnc` runs as root, because the password file is root-owned and 0600 — the
account the agent runs commands as cannot read the hash, and that account has
`sudo` only because the bootstrap installs packages with it. It runs with
`-noshm`: MIT-SHM segments belong to the account that started `Xvfb`, so a root
client attaching to them is refused with X BadAccess.

`x11vnc` re-reads its password file for each connection rather than once at
startup, which is why a new password takes effect without restarting the server
and without dropping a viewer already connected. `openDesktop` writes the new
hash first and only then hands out the address, so a minted address works the
moment it is returned and the previous one stops working at the same moment. A
timer replaces the password again when the address expires, so a copied link
stops being accepted 60 s after the click that made it; a session that is
already connected stays connected, and reconnecting after that needs a new
click.

The route a human's browser calls is
`GET /api/plugins/omd-sandbox-vm/desktop?name=<machine>`, and it answers
`{ name, url, expiresAt }` or a short JSON error: 400 for a missing name, 404
for a name outside the deployment or one no machine carries, 409 for a machine
that has no bridge, no VNC server, or an unprotected server, and 405 for a
method other than GET.

A frame of the same desktop has its own route,
`GET /api/plugins/omd-sandbox-vm/frame?name=<machine>`. It answers `image/png`
with `cache-control: no-store`, or the same shape of short JSON error: 400 for a
missing name, 404 for a name outside the deployment or one no machine carries,
409 for a machine that runs no display, 502 for a capture that ran and failed,
405 for a method other than GET. The capture is one guest command —
`DISPLAY=:99 scrot -o /tmp/omd-snap.png`, then `base64 -w0` of that file — so its
work directory is `/tmp` rather than the workspace, nothing it produces is
something a caller keeps, and the bytes that cross back are the only thing the
host ever sees. A guest that runs no `Xvfb` says so with its own exit status (9),
which the route turns into 409; a `scrot` that ran and failed is 502, because
only the second is a fault behind the route.

One frame is cached per machine for 1.5 s, and a request that arrives while a
capture is still running joins it, so a card polling faster than that costs one
guest process per window instead of one per poll. A failed capture is not
cached: the next poll asks the guest again rather than replaying the error.

A machine whose bootstrap fails is still a usable machine: `state` reports
`ready-no-desktop`, the failure is logged, and `provision` does not throw.

## Measured on this host

### Ubuntu 24.04 — 2026-11-07

Run against a throwaway `omd-imagecheck` machine (`--arch arm64 --cpus 2
--memory 2G`) created from the new default and provisioned through this
package's own `createSandboxVm`, so the numbers are the bootstrap's, not a
hand-typed script's.

- `orbctl create --isolated --arch arm64 --cpus 2 --memory 2G --mount <dir>:/workspace ubuntu:24.04 <name>` took 14.6 s with nothing cached locally, and the guest reports `Ubuntu 24.04.5 LTS`.
- The full `provision` on that machine — create, boot, one apt round for the desktop stack plus dev tooling, one for the Mozilla repository and Firefox, password, `Xvfb`, `openbox`, `x11vnc`, `websockify` answering — took 74.5 s and ended `state: "ready"`. A second fresh machine from the same code did the same in 84.4 s, so 75–85 s is the honest range with today's mirror latency.
- Guest `uname -m` is `aarch64`. Present afterwards: `git`, `curl`, `python3`, `pip3`, `gcc`, `firefox`, `Xvfb`, `x11vnc`, `websockify`, `openbox`, `xterm`, `scrot`, and `/etc/ssl/certs/ca-certificates.crt`.
- `/usr/bin/firefox` is Mozilla's own package, reporting `Mozilla Firefox 159.0.1`, not the snap stub: `dpkg -S /usr/bin/firefox` answers `firefox: /usr/bin/firefox` and `/etc/apt/preferences.d/mozilla` holds the 1000 priority that outranks it.
- The openbox root menu is written with `Browser` and `Terminal` entries, the first pointing at `firefox`. Probing that browser for `--version` is what accepts it: `dpkg -S` on the stub path and the pin are beside it, and `google-chrome`, `chromium` and `firefox-esr` are all absent on this image.
- The menu is live, not just a file: right-clicking display `:99` draws a popup whose two rows are `Browser` and `Terminal`, and clicking `Browser` starts Firefox — a capture taken after that click shows its first-run page with `https://www.mozilla.org - Firefox: About Your Rights` in the title bar. The popup is override-redirect, so `xwininfo -root -tree` does not name it; a screenshot or a click is the evidence, not a window search.
- Launching that `firefox` on `DISPLAY=:99` directly, without the menu, also produced a window: `captureFrame` returned a 56381-byte 1280×800 PNG showing Firefox's welcome page, and the bridge answered `200` on `/vnc.html` from inside the guest.
- Killing `Xvfb`, `x11vnc`, `websockify` and `openbox` and deleting the menu, then calling `provision` on the same live machine, re-ran the whole guest script in 1.1 s: all four daemons came back, the menu was rewritten, the bridge answered `200`, and no package work ran again because every probe passed.
- A machine whose `~/.config/openbox/menu.xml` already exists keeps it: `provision` after killing the same four daemons took 574 ms, restored all four, and left the file's own content untouched.
- `xdotool`, `xwininfo`, `xprop` and `x11-utils` are **not** part of the bootstrap, so a guest-originated check of the desktop has to use `scrot`, or install its own tools. `pgrep -x firefox` reports nothing even while Firefox runs — its process name is longer than `-x` matches — so a check that needs proof of the browser uses `pgrep firefox` or the screenshot.

The Debian branch was checked the same way on 2026-11-07, with a throwaway
`omd-debcheck` machine made from the old default `debian:12`: `provision` took
57.8 s, installed `chromium` (no Mozilla repository, no pin, no snap stub),
wrote it into the menu, and a frame captured after launching it shows Chromium's
`about:blank` window on display `:99`.

### The earlier Debian 12 machine — 2026-11-06

Every line in this block was run that day on the previous default; none is
taken from documentation.

- `orbctl create --isolated --arch arm64 --cpus 4 --memory 4G --mount <dir>:/workspace debian:12 <name>` takes 12–16 s with the image cached. A full `provision` from nothing — create, boot, apt install of the desktop stack, bridge answering — was 81.4 s; re-provisioning the same live machine was 416 ms with every desktop daemon's pid unchanged.
- Guest `uname -m` is `aarch64`. With `--cpus 2 --memory 2G`, `/sys/fs/cgroup/memory.max` is `2147483648` and `/sys/fs/cgroup/cpu.max` is `200000 100000`, so the caps are real while `free` and `nproc` still report the host.
- `orbctl list -f json` takes ~62 ms, `orbctl run -m <name> true` ~49 ms, so a readiness poll and a state read are cheap.
- `orbctl run` has **no** `--` separator: `orbctl run -m <name> -- uname -m` fails with `unknown flag --`, while `orbctl run -m <name> uname -m` works. Flags are `-m/--machine`, `-p/--path`, `-s/--shell`, `-u/--user`, `-w/--workdir`. A command is therefore always `/bin/sh -c <string>`.
- `orbctl run` on a **stopped** machine starts it, which is why readiness is a poll rather than a state field.
- Guest writes to the mounted `/workspace` appear on the host immediately, and host files are visible in the guest.
- From macOS a machine answers at `<name>.orb.local`; `http://<name>.orb.local:6080/vnc.html` returns 200 and a websocket upgrade on `/websockify` returns 101.
- A killed run leaves nothing behind in the guest: `sleep 15; touch /tmp/marker` with `timeoutMs: 300` reported `timeout`, and the marker was still absent 18 s later — killing `orbctl` ends the guest session.
- `orbctl create` can fail transiently with `start: start '<name>': starting the container failed`. It surfaces as `OrbctlError` with the argv, the exit status and orbctl's own stderr; retrying the same call succeeded.
- `x11vnc -storepasswd` writes exactly 8 bytes: the password's first 8 bytes encrypted under the well-known VNC DES key. The running server reads that file for **each** connection, not once at startup: with the file root-only and the server running as the guest user, every connection logged `Couldn't read password file`; after starting the server as root, a fresh password was accepted without restarting it.
- A root `x11vnc` attaching to an `Xvfb` started by the guest user fails with `X Error of failed request: BadAccess (attempt to access private resource denied) ... X_ShmAttach`; `-noshm` is required. The bridge serves `/vnc.html` while `x11vnc` is dead, which is why readiness now also probes TCP on 5900.
- RFB 3.8 on both `5900` and the `6080` websocket offers security type 2 only. The minted password answers `status 0`; an empty password, the password from a superseded address, and the same password after its 60 s window all answer `status 1`.
- The Debian 12 noVNC build accepts `?password=…&autoconnect=true&resize=remote`: a Tern tab opened at that address reported `已连接到（未加密）<machine>:99`, showed the guest's 1280×800 desktop with an xterm, and never opened the credentials dialog.
- `DISPLAY=:99 scrot -o /tmp/omd-snap.png` on the demo machine `omd-sandbox-issue-479f55fb` wrote a 13506-byte 1280×800 PNG; `base64 -w0` of it is 18008 characters, so one capture crosses in a single `orbctl run`, in about 50 ms.
- The frame route answered `200 image/png` with `cache-control: no-store` and 13506 bytes over a real socket. A second poll inside 1.5 s reused that frame without asking the guest, and a poll after the window captured again. Statuses seen: 400 for a missing name, 404 for a foreign name and for an absent machine, 405 for POST, 409 on a throwaway machine that ran no `Xvfb`, and 502 on that machine once a process named `Xvfb` existed: the display check passed and the capture command failed with `scrot: not found`, which is the fault/state split working.

## Limits

- **One machine per job.** The name is the whole identity and the mount is fixed at creation, so a different workspace needs a different name. There is no pool, no sharing and no second workspace on a machine.
- **No snapshot and no copy.** `dispose` deletes the machine permanently; only files under the mounted workspace outlive it. Cloning a machine means provisioning a new one and copying the workspace.
- **One live password per machine.** `x11vnc` accepts exactly one password, so a mint replaces the previous one: two clicks cannot both be live, and the second link invalidates the first. A session that is already connected survives the replacement, but reconnecting after the address expires needs a new click.
- **The plaintext lives in this process.** A host restart forgets it, so the guest keeps asking for a password nobody knows: `desktop` reports false and the wrench cannot open that machine until `provision` runs again on it, which mints and installs a new password without restarting `x11vnc`.
- **An unprotected bridge is never reused.** A machine created by an earlier version has `x11vnc` running with `-nopw`; the guest script refuses to install a password for a server that would not ask for one, so that machine reports `ready-no-desktop` until it is deleted and provisioned again. Silence would be worse: it would look protected.
- **The network is not the boundary.** The desktop is authenticated but the machine is not `--isolate-network`: another machine on the same OrbStack network can reach port 5900 and will be asked for the password.
- **The desktop bootstrap needs network.** It installs the desktop stack and the dev tooling from the distro mirrors and the browser from Mozilla's apt repository on first provision, so a machine created without network access ends up `ready-no-desktop`.
- **The browser is not the stub.** On Ubuntu the guest never installs the `firefox` or `chromium-browser` snap stubs; it adds Mozilla's apt repository and pins it above the stub, and on Debian it installs `chromium`. An image that ships no `apt` at all gets a desktop with no browser, reported on stderr and not as a failed provision.
- **A machine provisioned before this version keeps what it had.** A desktop that already answers takes the password-only path, so the guest script never runs: such a machine has no `scrot` (502 on the frame route), none of the dev tooling, and no browser, until it is deleted and provisioned again. Machines are not migrated in place.
- **A frame is a still, not a stream.** Every capture is one `scrot` process in the guest; there is no video and no delta, so motion is whatever series of stills the caller's poll rate produces.
- **`state` has no "stopped".** A stopped machine reports `ready` when the desktop is off (the next `exec` starts it) and `ready-no-desktop` when it is on.
- **`exec` is not a stream.** Both streams are captured and returned when the command ends, up to 8 MiB each; a guest process that should outlive the call has to detach itself, the way the desktop bootstrap does with `setsid`.

## Checks

```sh
cd plugins/omd-sandbox-vm && tsc --noEmit -p tsconfig.json
```

This reports three diagnostics that are present at `HEAD` as well, all in
`plugins/omd-internal-paths`: the schemastery `Schema<Config>` variance
complaint and the `webserver/index-inject` event name in `src/index.ts`, and
`Agent.name` in `src/service.ts`. They come from the host type packages this
checkout links, not from this package.

The driver itself was exercised against this host with a throwaway script:
provision, `uname -m` → `aarch64`, a guest write read back on the host, an exit
3, a `sleep 5` with `timeoutMs: 300` → `timeout`, an env addition, a `cwd`
override, `inspect` before and after `dispose`, `list`, every `vm://` document,
and a `watch` that reported `ready` then `absent`.

The image change and the guest script were exercised through this package's own
`createSandboxVm` on throwaway `ubuntu:24.04` and `debian:12` machines, all
deleted afterwards: a fresh `provision` on each, the tool and browser probes
listed in the measured section, a frame captured with the browser running, a
full re-run of the script after every desktop daemon was killed, and a
re-provision of a machine that already had a menu file of its own. The consumer
suites that build on this package live in `plugins/omd-onlyne`,
`plugins/omd-compute`, and `plugins/omd-issue-runner`, and import this one as
`omd-sandbox-vm`, `omd-sandbox-vm/machine`, `omd-sandbox-vm/bash-tool` and
`omd-sandbox-vm/types`. Run from `plugins/` after
`node plugins/link-host-runtime.mjs` has linked this package in:

```sh
bun test omd-onlyne omd-compute omd-issue-runner
```

which reported 28 pass, 0 fail on 2026-11-07.

The desktop boundary was checked against a real machine with another throwaway
script, deleted after the run: 26 assertions covering the password in the
minted URL and its TTL, `desktop: true` with no address in the roster or the
machine document, refusal of a model read of `vm://<machine>/desktop`, the
root-owned 0600 password file and `x11vnc -rfbauth`, RFB authentication with
and without the password over both TCP and the websocket, two mints producing
different credentials, revocation of the superseded and expired addresses, and
`dispose` clearing both the secret and its revocation timer. All 26 passed, and
the browser check in the measured section was done with a second machine that
was deleted afterwards.

The frame path was checked the same way, with throwaway scripts deleted after
the run: `captureFrame` returned a 13506-byte 1280×800 PNG twice on the demo
machine, an unknown name and a deployment with `desktop: false` were both
`DesktopUnavailable`, and the route was driven through a fake `connection.fetch`
seam — registered beside the desktop route, 200 with `image/png` and
`cache-control: no-store`, one guest capture for two polls inside the window and
a second capture after it, 400 for a missing name, 404 for a foreign name and an
absent machine, 405 for POST, 409 and 502 on a throwaway machine as described
above. The same handler was then served on a real socket and fetched back: `200
image/png`, 13506 bytes, `file` reporting a 1280×800 PNG.
