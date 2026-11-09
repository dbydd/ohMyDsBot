# Agent Identity, Resource Mapping and VM Ownership

## 1. Context and Problem Statement

During the live DS-Bot demonstration on 2026-11-06, a Bot (`Chief` / `Ombra`) filed a coding task via the `msg` tool over Onlyne. The interaction exposed four architectural boundaries that required formalization:

1. **Bare UUID Confusion in Agent Loops**: Onlyne node identities (`urn:onlyne:agent:<sessionId>`) and thread IDs are raw UUIDs. When reasoning about thread hierarchy, LLMs frequently mistake thread boundaries or fail string equality checks.
2. **Disconnected Review Flow**: When the user asked the Bot to send a review feedback, the Bot sent the review into a thread different from the one holding the runner job. The runner replied that no job held the thread, prompting the Bot to file a second issue, which forked a second VM (`omd-sandbox-issue-26f06385`) for the same underlying task.
3. **VM Lifetime Tied to Issues Instead of Agents**: Sandboxes were spawned per issue job. When an agent required multiple turns or reviews, machines multiplied needlessly.
4. **Credential Leakage in Model Visibility**: Desktop URLs carrying raw IP/port or auth tokens were visible to models through internal path representations.

---

## 2. Core Decisions

### 2.1 The Two-Surface Principle: Internal Path vs. Resource Identity

- **Transport Identity**: Underlying network/protocol addresses (`NodeId`, `SessionId`, `ThreadRef`) remain whatever the upstream protocol dictates (e.g., `urn:onlyne:agent:<sessionId>`). We **do not mandate a custom NodeId grammar** or inject fragile regex wrappers into the transport.
- **Model-Facing Surface**: Agents, prompts, and UI components interact exclusively with semantic, hierarchy-aware internal paths (e.g., `onlyne://runner/issue/<id>`).
- **Explicit Translation Table**: A single in-memory mapping table maintains `internal path ↔ resource identity`. No dual-writes, no legacy compatibility shims, no "historical baggage":
  - `workers.set('onlyne://runner/issue/' + id, id)`
  - Resolution resolves via exact table lookup (`workers.get(path)`), keeping the protocol clean and the model cognitive load near zero.

### 2.2 Ownership Invariant: One VM per Agent

- **Identity Anchor**: A virtual machine is an execution capability owned by an **Agent identity**, not an ephemeral issue ticket.
- **Subagent / Subbot Hierarchy**:
  - An issue runner spawns a coding agent owned by the invoking Bot (`parentAgent` linkage).
  - The coding agent owns its VM for its entire task lifetime.
  - Reviews continue against the **same worker** and the **same machine**.
  - Disposal of the worker cascades to its machine and its COW mount atomically.

### 2.3 Wrench-Centered Security Boundary

- All access tickets, VNC hashes, and noVNC password salts are minted, held, and rotated by the host daemon (`SandboxVm`).
- **Zero-Token Exposure**: Neither the model prompt, nor session events, nor internal path reads ever contain the password or authenticated URL.
- **Human Entry**: The DS-Bot wrench drawer tab (`Studio -> 沙箱`) is the sole human entry point. It calls a host-authenticated endpoint (`GET /api/plugins/omd-sandbox-vm/desktop?name=<id>`) protected by the session cookie to mint an ephemeral, 60-second one-time URL.

---

## 3. Structural Mapping Table

| Logical Internal Path | Physical Entity | Purpose | Model Visible? |
|---|---|---|---|
| `onlyne://runner/issue/<id>` | Job in `omd-issue-runner` | Identifies the coding agent worker and its checkout | Yes (in PR cards & notes) |
| `vm://<machine>` | ARM64 Linux VM in `omd-sandbox-vm` | Inspection document (CPU, Memory, State, Workspace) | Yes (metadata only, no auth/URL) |
| `vm://<machine>/desktop` | Instruction pointer | Text instruction steering scripts to host API | Yes (Instruction text only) |
| `/api/plugins/omd-sandbox-vm/desktop` | Host HTTP Route | Mints ephemeral 60s ticketed noVNC URL | No (HTTP-only, requires cookie) |
| `/workspace` | VirtioFS mount point | Shared APFS clonefile directory | Yes (as target cwd) |

---

## 4. Observed Facts Reference

- `<onlyne>/external-integrations/dsh-onlyne/omd-issue-runner/src/jobs.ts:124`: Worker address formatting `onlyne://runner/issue/${job.id}`.
- `<onlyne>/external-integrations/dsh-onlyne/omd-issue-runner/src/jobs.ts:334`: `byWorker` lookup using explicit translation map.
- `plugins/omd-sandbox-vm/src/machine.ts:662`: `openDesktop` minting 60-second ephemeral password ticket.
- `plugins/omd-context-tavern/src/client/index.js:2367`: Wrench Studio registration via `window.dshBot.registerDetailsTab`.
