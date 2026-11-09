# omd-skill-catalog

The session skill catalog, published by this plugin, with the upstream `skill`
loader denied. `read skill://<name>` is the only way a model loads a skill.

## Why it exists

Upstream `dsh-tool-skill` owns the catalog and the `skill` tool together, and
it emits the catalog only while the calling agent's tool view still resolves
its own `skill` registration. Denying the tool alone therefore removes the
skill list as well, leaving the model with a read path and no names to use on
it. This package takes the catalog over, so the pair can be split.

At `agent/created`, for every agent whose composition inherited `skill`, the
plugin installs `agent.ctx.tools.restrict({ deny: ['skill'] })`. Only agents
where the deny actually took get this plugin's catalog.

## Duplicate catalogs

The catalog is sourced as `omd-skill-catalog`, deliberately not upstream's
`skill-catalog`. Upstream's listeners stay mounted after the deny and compute
an empty catalog on every pre-step; a shared kind would let them recognize
this plugin's message as their own and replace it with "no skills are
available". A distinct kind leaves them with nothing to recognize, so they stay
silent.

When both catalogs could exist:

- **The deny took** → this plugin's catalog is authoritative, and any upstream
  `skill-catalog` message is dropped from the step on the way out. A
  pre-migration session still has such a message in its log, so the first
  publication here uses the replacement framing.
- **The deny did not take** (`skill` still resolvable afterwards, e.g. a
  registration in the agent's own scope, which that scope's own mask cannot
  remove) → upstream's catalog is authoritative and this plugin publishes
  nothing. Its catalog is the one that matches the tool the model can still
  see.

The test is `tools.get('skill', agent) !== undefined` right after `restrict`.

## Configuration

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | `false` leaves both the tool and the catalog to upstream. |
| `descriptionMaxLength` | `500` | Cap on each rendered description; minimum 3. Volatile, so it reloads live. |

## Mount

```yaml
- insert:
    - id: omd-skill-catalog
      name: omd-skill-catalog
```
