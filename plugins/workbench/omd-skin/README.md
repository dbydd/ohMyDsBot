# omd-skin

A global visual skin for the dsh web frame, drawn from a Tern-style reference:
near-black layered surfaces separated by hairlines, muted warm text, one mint
accent, generous corner radii, and the app presented as a window on a darker
desk.

The skin owns no state and renders no node. It injects one stylesheet and marks
`html[data-omd-skin='tern']`; removing the plugin removes the marker and the
`<style>` tag with it.

## What it changes

| Area | Effect |
| --- | --- |
| Window | `body` gains a 10px desk margin; the shell frame gets a 16px radius, a hairline border, and a deep shadow. |
| Panes | The centre column and the right column become inset cards (8px gaps, 14px radius, hairline border), so the shell reads as sidebar plus floating panes instead of one flat sheet. |
| Palette | Dark mode uses layered charcoal surfaces, mint `#9fe3a6` accents, and `#93b7f7` links. Light mode uses pale surfaces with dark text. Cards, bubbles, the composer, and code blocks follow the active theme. |
| Radii | `--dsw-radius-*` is raised one step (4/6/10/14/18px). |
| Sidebar | Darker surface, hairline divider, 12.5px type, rounded hover and active rows. |
| Composer | A floating card: raised fill, 16px radius, inset hairline, soft shadow. |
| Tool calls | Quiet cards with a 0.5px hairline and no elevation. |
| Code | Markdown code blocks get a hairline border and 12px radius. |
| Chrome | Thin scrollbars, mint selection and focus ring, reduced-motion fallback. |

## Known limitations

- **Scoped by local class names.** The frame's classes are CSS-module locals in a
  per-build hash (`pI_x6G_sidebarCol`), so rules match `[class*='sidebarCol']`.
  This follows `omd-chat-shell`'s documented contract: the local name survives
  upstream builds, the hash does not matter. A renamed local silently drops the
  rule. Data attributes (`[data-composer-seat]`, `[data-ds-dark-theme]`) are the
  stable hooks.
- **Theme marker.** Palette selection follows `body[data-ds-dark-theme]` and updates when the host changes the theme.
- **Not a layout change.** The skin restyles the shipped columns; it does not add
  Tern's tab strip, right-hand terminal panes, or dock.
- **`!important` on tokens.** The theme runtime writes alias tokens as inline
  variables, so only an important author rule can override them.
