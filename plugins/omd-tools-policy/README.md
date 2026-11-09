# omd-tools-policy

One model-facing surface per agent. It removes tools, prompt sections, and
slash commands from what one agent sees, and pauses a goal that is already
running, without touching the preset composition, the plugins that own those
contributions, or anyone else's config. Presets that must keep the full surface
are exempted by id.

```yaml
- insert:
    - id: omd-tools-policy
      name: omd-tools-policy
      config:
        deny: [create_goal, get_goal, update_goal, lsp_diagnostics,
               render_ui, render_text, render_canvas, render_scene, render_mechanism,
               update_ui, inspect_ui, patch_ui, ui_catalog, validate_ui,
               render_video, preview_video, inspect_video, process_video, synthesize_voice]
        blankSections: [tool:goal,
                        generative-ui:design-skill, generative-ui:protocol, generative-ui:worked-examples]
        redirectCommands:
          - name: goal
            message: "目标功能已移除：把会话目标写在待办根条目（todos[0]）的 goal 字段里。"
        pauseGoals: true
        exemptPresets: [visual]
```

## Config

| field | default | meaning |
|---|---|---|
| `deny` | `[]` | Tool names hidden from every agent that inherits them. |
| `blankSections` | `[]` | System-prompt section names replaced by an empty section of the same name. |
| `redirectCommands` | `[]` | `{name, message}` pairs: each inherited slash command is shadowed by a direct-handled notice. |
| `pauseGoals` | `false` | Pause a goal that is already active when the agent is created. |
| `exemptPresets` | `[]` | Preset ids (exact) that skip every mechanism above. |

## How it applies

Everything runs in one `agent/created` listener, in this order: preset
exemption, tool restriction, section blanks, command redirects, goal pause.

Each mechanism is a registration on `agent.ctx`, so it lives exactly as long as
that agent and unwinds with it. Nothing is registered on the host context: a
global restriction or section would hit every agent, and the registries refuse
that on purpose.

Sections and commands use the same merge as tools — global layer, every
ancestor (a preset is one), then the agent's own scope, nearest wins a name.
So a blank section or a redirect **replaces** the inherited contribution rather
than adding to it.

### Tool deny

The denial set is intersected with `tools.schemas(agent)` before it reaches
`restrict`. One profile-wide list spans presets that mount different plugins —
a preset may not compose `dsh-tool-lsp` at all — and `restrict` rejects a name
the composition does not provide. The intersection keeps the list declarative,
at the cost of silence on a typo. A name the agent's own scope registers still
throws: `schemas` includes it but `restrict` only accepts inherited names
(`restrict` filters the inherited map, then own registrations are added
outside the filter).

### Blank sections

A section is registered with the same name and `text: ''`; the near layer wins
the name, and the renderer drops empty sections, so the inherited text is gone
rather than appended to. That is a whole-section replacement: whatever the
upstream section contained is not partially preserved.

### Command redirects

The replacement command has no model turn: its handler returns the configured
message directly, so invoking it cannot create a goal, open a turn, or reach
the tool surface. The command panel lists it with that message as its
description, which is the visible consequence of the redirect.

### Goal pause

`ctx.goals.get(agent)` returning an `active` goal is paused with its current
revision. With no goal, or a goal in any other phase, nothing happens. The
`/goal` command is separately redirected, so the two do not fight: the notice
answers a human, the pause handles continuation authority that already exists.

## Why motion-ui is all-or-nothing

`deny` is not the only half of the motion surface; the bundle also injects three
prompt sections (`generative-ui:design-skill`, `generative-ui:protocol`,
`generative-ui:worked-examples`). Hiding the tools while keeping the sections
would hand the model a 9 KB tool contract for tools it cannot call. Blanking
the sections while keeping some tools is the other trap: `render_canvas`'s
description says "Use the injected canvas contract", `render_ui` refers to
`ui_catalog`, `render_video` refers to `preview_video`, and `update_ui` depends
on `inspect_ui` — a partial set leaves descriptions that name denied tools, and
a blanked protocol section leaves every remaining render tool pointing at
nothing.

So the config above removes **all 15 motion tools and all three sections** from
the main agent, and exempts the `visual` preset, which keeps both (the tools
come from the bundle's global layer, the sections from its global prompt
registrations). Do not "keep a few" later: either the agent owns the motion
surface or it does not.

## Measured behaviour

Probe: a copy of the `omd` profile, this plugin linked into it and added with
`--patch`, the web app booted on a free port, one real turn through the session
API (`session/create`, `session/prompt`, `commands/list`, `commands/execute`),
then the uncompressed session log read directly. `request/header` is the actual
model-facing request envelope and `system/message` the exact prompt, not
`--dump-config`.

| run | config | tools | prompt chars |
|---|---|---|---|
| baseline | plugin absent | 51 | 19515 |
| masked | the config above | 32 | 5089 |
| visual preset | the config above, `agentPreset: visual` | 30 | 17952 |

The masked run removed exactly 19 names and added none; the set difference is
the `deny` list verbatim, and no remaining tool description mentions a denied
name. The masked prompt contains no `create_goal`, `get_goal`, `update_goal`,
`render_`, `generative-ui`, or `DSHUI` text — the word `goal` does not appear
at all.

The `visual` session kept all 15 motion tools and all three goal tools, its
prompt still contains the motion sections and the goal guidance, `/goal` keeps
its original description, and `/goal 视觉目标` created an active goal. The
minimal `visual` preset used for the probe declared only `persona`, `tool-fs`,
`tool-goal`, and `command-goal`; motion tools come from the bundle's global
layer, which is why they survive the preset switch.

`pauseGoals` was checked by resuming a session that held an active goal
revision 1: at `agent/created` the plugin recorded a `pause` mutation, and the
projection read `paused` at revision 2. `/goal 新目标` in that session returned
the redirect notice and left the goal paused at the same revision; no new goal
was created.

The baseline count moved from the plan's 52 to 51 because the profile gained
`omd-todo` and changed its preset rows between measurements; compare runs on
the same profile, not against the older number.

## Limits

- A tool re-registered into the agent's own scope cannot be denied here.
- A name in `deny` that the composition does not mount is silently skipped
  (see the intersection above).
- The exemption is read from `agent.session.header.agentPreset`, so an agent
  without a preset roster never matches an exempt id.
- Hiding a tool or a section changes what the model sees and calls; the owning
  plugin still mounts, and its other effects (routes, client UI, event
  listeners) stay.
- `pauseGoals` acts only at `agent/created`. A goal created later in the same
  session is unaffected because the tool that could create it is denied and
  `/goal` is redirected; a goal created by other means is outside this policy.
- `run_code` (the PTC presentation transport) is not a nameable tool; the
  registry rejects it.
