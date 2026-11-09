# omd-project-config

Per-project parameters for omd. The Host half resolves plugin defaults → the
repository's `.omd/config.json` → a personal override in `ctx.storageDomain`,
and publishes the result as `ctx.projectConfig`; the browser half is the panel
that edits the personal layer.

Design notes, the storage layout and the field table are in
`docs/omd-project-config.md`. This file records the panel's entry points and the
DOM contract the DS-Bot seat depends on.

## Entry points

One panel store, one `projectConfig` Remote namespace, three ways in:

| Seat | Where it shows | Registration |
|---|---|---|
| `shell.overlay` | the panel dialog | `omd.project-config`, component `ProjectConfigPanel` |
| `sidebar.footer.action` | shell sidebar foot, icon + label | `omd.project-config`, order 100 |
| `shell.overlay` | DS-Bot's own left column foot | `omd.project-config.dsbot`, component `ProjectConfigDsBotAction` |

`/project-config` runs the same `panel.open` for the same workspace, and is
listed only while a workspace is current.

## The DS-Bot seat

DS-Bot portals its own left column (`.bt-leftcol`) over the shell's sidebar and
forces that sidebar's grid track to zero, so the `sidebar.footer.action` button
is still in the DOM and in the accessibility tree but nothing can click it. The
column's foot is DS-Bot's React tree and not ours to edit, so the panel's button
moves there through the only seam available:

1. A `MutationObserver` on `document.body` — throttled to one task — records the
   current `.bt-leftcol-foot` element in `createFootStore`. DS-Bot mounts the
   column after this plugin and rebuilds the element as the surface changes, so
   the element's identity, not a flag, is the state.
2. `ProjectConfigDsBotAction` appends a `div.omd-pc-dsbot-seat`
   (`display: contents`, marked `data-omd-project-config`) to that foot and
   portals the shared `ProjectSettingsButton` into it. The button stays inside
   this plugin's React tree: same store, same Remote mount, same locale, same
   `useSessions`/`useWorkspaces` binding as the shell seat.
3. `ProjectConfigFooter` reads the same store and renders nothing while the foot
   exists. Exactly one entry is on screen at any time: the DS-Bot seat while its
   column is mounted, the shell seat in plain dsh and in DS-Bot's Agent view,
   where the column is gone and the shell sidebar is back.

The DS-Bot coupling is three class names — `.bt-leftcol-foot` to attach to and
`.bt-leftcol[data-left=rail]` to switch the button from a labelled row to a
36px round icon button. Both live in `ds-bot/src/client/sidebar.js` and
`styles.js`; the stylesheet falls back to dsh tokens when DS-Bot's `--bt-*`
custom properties are absent, so an upstream rename costs the seat, not the
plugin: the shell seat simply stays in charge.

Unload removes everything the fiber created: the observer disconnects, the
pending scan timer clears, the seat element leaves with its effect, and the
portal unmounts with the slot registration. Nothing is written to DS-Bot's
files, and no upstream plugin or profile is touched.

## Verification selectors

Open the app in a browser, with a workspace selected (the button is disabled
otherwise, with the reason in its `title`).

| What | Selector |
|---|---|
| DS-Bot entry (column shown) | `.bt-leftcol-foot [data-omd-project-config] button.omd-pc-dsbot-action` |
| DS-Bot entry label | `.bt-leftcol-foot .omd-pc-dsbot-action .omd-pc-footer-label` (hidden at `[data-left=rail]`) |
| Shell entry (plain dsh, or DS-Bot Agent view) | `[data-slot="sidebar.footer.action"] button.omd-pc-footer` |
| Only one entry present | `document.querySelectorAll('button.omd-pc-footer, button.omd-pc-dsbot-action').length === 1` |
| Panel dialog | `div[role="dialog"].omd-pc-dialog` |
| Field row and its source | `.omd-pc-dialog .omd-pc-row` / `.omd-pc-source` |
| Save button | `.omd-pc-dialog .omd-pc-button[data-primary="true"]` |
| Clear personal override | `.omd-pc-dialog .omd-pc-footer-bar > .omd-pc-button` |

Read-back after Save: `ctx.projectConfig.resolve(cwd)` on the Host (or reopen
the dialog; each field's source marker turns into `source.user` for the keys
written).
