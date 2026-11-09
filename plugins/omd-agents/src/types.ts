/**
 * Agent-catalog vocabulary shared by `omd-agents` (provider) and the packages
 * that dispatch from it.
 *
 * Reproduced from the omd-core contract §3 so consumers never import another
 * `omd-*` package: the `Context` augmentation below merges with the provider's
 * own declaration on the same service name.
 *
 * @module omd-agents/types
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentCatalog: AgentCatalog
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
  source: 'user' | 'project' | 'config'
}

/** The catalog service `omd-agents` provides on the context. */
export interface AgentCatalog {
  /** Every loaded agent, ordered by `name`. */
  list(): readonly AgentDefinition[]
  /** Look an agent up by name; an unknown name returns undefined. */
  resolve(name: string): AgentDefinition | undefined
}
