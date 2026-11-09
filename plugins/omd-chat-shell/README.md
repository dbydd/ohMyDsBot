# omd-chat-shell

A blank session keeps dsh's `hero` layout: the input card sits in the middle of
the column, above it the product mark and headline, and between them a workspace
row. A session that already has turns uses the `active` layout instead: the card
is docked at the bottom and the transcript owns the column. This plugin makes the
blank session use the second layout, so starting a conversation does not move the
input card.

## What the stylesheet changes

All rules are scoped to `[data-phase='hero']`, so an active session is untouched.

| Selector | Effect |
| --- | --- |
| `[data-conversation-scroll]` | Pushes the flex column to its end instead of centering the composer stack (`justify-content: flex-end`). |
| `[class*='composerHero']` | Removes the hero stack's `padding-bottom: 32px` lift. |
| `[class*='composerHero'] > :nth-child(1)`, `> :nth-child(2)` | Hides the product-mark/headline block and the workspace row. Children 3 (`conversation.input.dock` slot) and 4 (the input card) stay visible. |
| `[data-composer-seat]` | Adds the 12px bottom inset the active layout gives the seat. |

## The one class-name dependency

`composerHero` is a CSS-module local name; the built page carries it inside a
hashed class, and the `[class*='…']` prefix match relies on the hash preserving
the local name. It is the only rule here that does not key off a data attribute.
The data attributes — `data-phase`, `data-conversation-scroll`,
`data-composer-seat` — are the stable contract and have survived upstream
changes so far.

To hide the right nodes, the rule also depends on the child order of the hero
composer stack: 1 = hero chrome, 2 = workspace row, 3 = the dock slot, 4 = the
input card. Inserting a row above the dock slot would shift the indices.

## Spotting a break after an upstream update

Open a new session (no turns yet):

- Input card centered with the product mark above it → the stylesheet did not
  load, or `dockBlankComposer` is `false`. Check that the plugin is mounted and
  that a `<style id="omd-chat-shell">` exists in `<head>`.
- Input card docked at the bottom but the product mark and workspace row still
  visible → the stack's first two children moved or were renamed; inspect
  `[class*='composerHero']` and re-derive the indices.
- Nothing changed except whitespace → `composerHero` no longer appears in the
  built class names; update the prefix match against the current
  `ConversationRoot.module.css` upstream.
- A started session looks wrong → these rules should never reach it; the
  `[data-phase='hero']` prefix is missing or the phase attribute moved.

## Configuration

`dockBlankComposer` (default `true`) is the only field. `false` makes the client
half install no stylesheet at all, restoring upstream's centered hero. The host
half publishes the value to the page as `__DSH_CHAT_SHELL_CONFIG__`, because a
client bundle is created with no entry config of its own.

## Mounting

```yaml
- insert:
    - id: omd-chat-shell
      name: omd-chat-shell
```

The package declares `dsh.client: { platform: 'web' }`, so it must carry both
halves: `src/index.ts` (host, publishes the config) and `src/client/index.js`
(hand-written browser module; no build step).
