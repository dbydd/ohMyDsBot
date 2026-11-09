# omd-workbench

Workbench chrome for the dsh web UI. Milestone 1 is the top bar: a fixed strip
above the shipped frame showing the selected session title, a sidebar toggle,
and a new-session action.

The bar registers into `shell.overlay` and reserves `#root` by its own height,
composed with `--omd-ticker-height` so the ticker and the bar stack instead of
overlapping. It owns no session state: the title is the browser title the shell
already projects, and the actions are `layout.toggleSidebar` and
`uiWorkspace.startSession`.

The DS Bot fixed sidebar and drawers start below both strips, using the same
height variables as the frame. Their headers remain clear of the workbench.

## Roadmap

1. Top bar (this milestone).
2. Left resource tree (files / git) replacing the shipped session list as the
   sidebar's content; session switching moves into top tabs.
3. Session tabs driven by the shared client store
   (`@deepseek-ai/dsh-client-store`, the module ui-layout takes `useSessions`
   from).

## Known limitations

- The title is read from `document.title`; a session rename reaches the bar only
  after the shell updates the browser title.
- No workspace switcher yet: the shell exposes no client list API on `ctx`;
  the store module or a Host resource will supply it.
