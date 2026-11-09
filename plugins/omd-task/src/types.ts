/**
 * Cross-package vocabulary for `omd-task`: the agent catalog it reads (copied
 * verbatim from the omd-core contract §3 so this package never imports another
 * `omd-*` package), the two optional services it uses when they are mounted,
 * and the subagent surface it dispatches through.
 *
 * @module omd-task/types
 */

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by `omd-agents`; absent packages fall back to passing `agent` through by name. */
    agentCatalog: AgentCatalog
    /** Provided by `omd-worktree-alloc`; absent packages reject `isolated` tasks. */
    worktreeAlloc: WorktreeAllocator
  }
}

/** One agent definition read from a markdown file. */
export interface AgentDefinition {
  /** frontmatter `name`, unique across both directories. */
  name: string
  /** frontmatter `description`, one line. */
  description: string
  /** Complete markdown body without its frontmatter, used as the child's system instructions. */
  instructions: string
  /** Allowed tool names; absent means the child inherits the caller's tools. */
  tools?: readonly string[]
  /** `provider/model`; absent means inherit. */
  model?: string
  /** `low|medium|high|...`; absent means inherit. */
  thinkingLevel?: string
  /** Agent names this one may spawn; absent means unlimited, an empty array forbids spawning. */
  spawns?: readonly string[]
  /** Whether the delegation to this agent is handled as blocking. */
  blocking?: boolean
  /** Declared output mode from the file's `output` field, passed through verbatim. */
  output?: string
  /** Which directory the definition came from, for diagnostics. */
  source: 'user' | 'project'
}

/** The catalog service `omd-agents` provides on the context. */
export interface AgentCatalog {
  /** Every loaded agent, ordered by `name`. */
  list(): readonly AgentDefinition[]
  /** Look an agent up by name; an unknown name returns undefined. */
  resolve(name: string): AgentDefinition | undefined
}

/** One isolated working copy created for a child agent. Only `path` is read here. */
export interface WorktreeAllocation {
  /** Absolute working-copy directory; passed as the child's working directory. */
  path: string
  /** Identifier the allocator named the copy with, exactly as the caller named it. */
  name: string
  /** Absolute root of the directory patches are applied back to. */
  sourceRoot: string
  /** Backend that created the tree. */
  backend: 'cow'
}

/** What landing one isolated run's changes produced. */
export interface IsolationResult {
  /** `applied` — the changes are in the parent tree; `conflict` — they are not, and the tree is kept. */
  outcome: 'applied' | 'conflict' | 'failed'
  /** Repository-relative paths git refused, sorted; empty unless `conflict`. */
  conflicts: string[]
  /** Git's own explanation, or the reason the tree could not be settled. */
  detail?: string
}

/** The allocator `omd-worktree-alloc` provides on the context. */
export interface WorktreeAllocator {
  /**
   * Clone a directory into an isolated copy without touching the caller's own
   * working directory.
   *
   * @param name identifier, also the copy's path below the allocator's pool, for
   * example `omd/task/<childId>`
   * @param cwd the directory to copy; no repository is required
   * @returns the copy, its name, and the root patches apply back to
   */
  allocate(name: string, cwd?: string): Promise<WorktreeAllocation>
  /**
   * Apply the isolated run's change set to the parent checkout, serially, with
   * nothing written when a dry run refuses.
   *
   * @param handle checkout returned by `allocate`
   * @returns the outcome and, for a conflict, the files git refused
   */
  apply(handle: WorktreeAllocation): Promise<IsolationResult>
  /**
   * Remove one allocated copy and its baseline.
   *
   * @param handle checkout returned by `allocate`
   * @param options `force` discards uncommitted files instead of refusing
   */
  release(handle: WorktreeAllocation, options?: { force?: boolean }): Promise<void>
}

// ── subagent seam ────────────────────────────────────────────────────────────
// Mirrored from `@deepseek-ai/dsh-subagent/src/types.ts` so the plugin compiles
// against the peer without widening the service's exported surface.

/** Why a subagent run ended; consumers branch on the known cases and fall through. */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** Task and optional capabilities supplied to a backend. */
export interface SubagentStartRequest {
  /** Initial child directory; relative paths resolve against the parent's current directory. */
  readonly cwd?: string
  /** Optional independent preset id; omission joins the parent's current generation. */
  readonly agentPreset?: string
  /** Optional short display label persisted with a session-backed child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /** The spawning agent; its effective directory supplies the default cwd. */
  readonly parent: Agent
  /** Cancellation signal from the spawning context. */
  readonly signal: AbortSignal
  /** Optional host-Agent provider, model, reasoning-effort, and output-token overrides. */
  readonly agentOptions?: AgentOptions
  /** Object-rooted JSON Schema the child must satisfy to return `structured`. */
  readonly outputSchema?: object
  /** Optional absolute delegation-depth cap for the child being started. */
  readonly maxDepth?: number
}

/** One managed child execution and its result delivery policy. */
export interface SubagentActivationSpec {
  /** Registered backend to use. */
  readonly provider: string
  /** Short task label retained in cataloged child membership. */
  readonly label: string
  /** Optional reserved identity for a local child; external backends allocate their own ids. */
  readonly childId?: SessionId
  /** Task, parent, and backend-supported execution options. */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>
  /** Cancellation before publication; callers own later cancellation through dispose. */
  readonly signal: AbortSignal
  /** Parent delivery notifies the model; caller delivery only returns the result. */
  readonly delivery: 'parent' | 'caller'
}

/** The terminal outcome of a subagent run. */
export interface SubagentResult {
  /** The child's final assistant output. */
  readonly output: readonly ContentBlock[]
  /** The structured result after a requested `outputSchema` was successfully satisfied. */
  readonly structured?: unknown
  /** Provider-authored, non-assistant failure detail for a non-`completed` result. */
  readonly diagnostic?: string
  /** Why the run ended. */
  readonly stopReason: SubagentStopReason
}

/** A managed execution; disposal addresses this exact activation, never a later resume. */
export interface SubagentActivation {
  /** Stable identity of the child. */
  readonly childId: SessionId
  /** Accepted inbox message, when the backend has a local inbox. */
  readonly messageId?: string
  /** Execution result after teardown settles and notifications are sent. */
  readonly result: Promise<SubagentResult>
  /** Stop and release this activation and its owned descendants. */
  dispose(): Promise<void>
}

/** One registered transport for running child agents. */
export interface SubagentProvider {
  /** Provider name this instance registers under. */
  readonly name: string
  /** Which start-time options the manager may forward. */
  readonly capabilities: {
    readonly agentOptions: boolean
    readonly agentPreset: boolean
    readonly outputSchema: boolean
    readonly depthLimit: boolean
  }
  /** Whether children carry the parent's conversation prefix. */
  readonly inheritsParentContext: boolean
  /**
   * Present only on continuable backends. Method presence is the capability:
   * a provider without it cannot start a child under a reserved id.
   */
  prepareContinuable?(request: unknown): Promise<unknown>
}

/** The subagent service as this package consumes it. */
export interface SubagentRuntime {
  /** Start a local or external child. */
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  /** Look up a registered provider by name. */
  getProvider(name: string): SubagentProvider | undefined
  /** List registered provider names in insertion order. */
  list(): string[]
  /** Resolve a delegation tool's depth policy against the current user setting. */
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined
}
