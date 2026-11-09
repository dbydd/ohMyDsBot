# omd-agents

Agent delegation catalog for dsh.

## Features

- **Standard capability tiers**: Built-in definitions for standard agent tiers mapping to gateway model routes:
  - `engineer`: `magpie/group/engineer` — Technical implementation, multi-file edits, bug fixes.
  - `labor`: `magpie/group/labor` — Routine bulk tasks, deterministic programming, mechanical rewrites.
  - `philosopher`: `magpie/group/philosopher` — Deep reasoning, foundational architecture, open problem solving.
  - `theorist`: `magpie/group/theorist` — Architecture trade-offs, interface design, specification refinement.
- **Profile configuration**: Custom agent roles and overrides configured via `Config.agents`.
- **Filesystem definition discovery**: Scans user (`~/.dsh/agent/agents/*.md`) and project (`<cwd>/.dsh/agents/*.md`) frontmatter markdown files if present.
- **System prompt catalog**: Renders `# Available Agents` into the model's assembled system prompt.
- **Service `ctx.agentCatalog`**: Provides `list()` and `resolve(name)` consumed by `omd-task` to configure subagent model routes, instructions, and tools.
