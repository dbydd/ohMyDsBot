# NOTICE

This repository is licensed under the **GNU General Public License, version 3
or (at your option) any later version**. The full text is in `LICENSE`.

Every file in this repository that we wrote is covered by that license. The
components below keep their own licenses; they are compatible with GPLv3, and
their notices are reproduced or pointed to as each one requires.

## Dependencies and derived work

### deepseek-harness

- Source: <https://github.com/deepseek-ai/deepseek-harness>
- Runtime version: `0.2.1-rc.5`. The read-only reference checkout remains at
  `0.2.1-rc.2` (commit `687f282e8625c6b8d11ff58211a90524be2e4317`).
- License: MIT, Copyright (c) 2026 DeepSeek (`refs/deepseek-harness/LICENSE`)
- Relationship: runtime host. It is consumed as installed packages and a
  read-only checkout under `refs/`; it is not redistributed from this
  repository. Plugins here register into its Cordis tree and depend on its
  services and event types.

### DS-Bot

- Source: <https://github.com/Fei2411/DS-Bot>
- Version: `0.2.7`, commit `71d344bf193f3f18185f25de3d8e5c483046910a`
- License: Apache-2.0, preserved in `ds-bot/LICENSE`; upstream notices remain
  in `ds-bot/NOTICE`.
- Relationship: application base, pinned as the read-only `ds-bot/` submodule.
  Local extensions live in this repository's plugins and profile overlays.

### oh-my-pi

- Source: <https://github.com/can1357/oh-my-pi>
- License: MIT, Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026
  Can Bölük, Copyright (c) 2026 Stencil Labs, Inc.
- Relationship: design source for `plugins/workbench/omd-chart-plan/`. That plugin
  re-implements the chart-planning heuristic of `packages/tui/src/charts/` and
  `packages/coding-agent/src/auto-graph/`: the decision cascade, the confidence
  gates, the question set and their thresholds come from there. No upstream
  file is copied; the structure and constants are. The implementation is a
  narrower subset — kinds and cell formats we do not support are omitted
  instead of approximated.

  MIT requires the copyright and permission notice to travel with copies or
  substantial portions of the software. The notice text for the parts we derive
  from is reproduced below.

  ```
  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

### dsh-genui (vendored inside the motion-ui plugin)

- Location: `external-plugins/dsh-motion-ui/vendor/dsh-genui/`
- Source: <https://github.com/omdsh-dev/dsh-genui>, version 0.11.4, commit
  `7ff0cf5ea474573a86a912e0cfe938ce8093a66f`
- License: MIT, preserved in `external-plugins/dsh-motion-ui/vendor/dsh-genui/LICENSE`
- Relationship: third-party plugin vendored for reproducible builds; what is
  embedded and what stays upstream is described in
  `external-plugins/dsh-motion-ui/vendor/dsh-genui/NOTICE.md` and
  `skills/motion-design/NOTICE.md`.

### omp-hindsight (core and recall behavior in omd-hindsight)

- Source: <https://github.com/dbydd/omp-hindsight>, version `0.1.2`, commit `984e314`
- License: MIT, Copyright (c) 2026 dbydd
- Location: `plugins/context/omd-hindsight/src/core/`, `plugins/context/omd-hindsight/ssot/`, `plugins/context/omd-hindsight/packs/`
- Relationship: vendored reference core implementation and prompt pack.
  - Vendored:
    - `ssot/spec.ts`: single source of truth for operations, path routes, judge questions, and schemas.
    - `src/core/*`: HTTP client, configuration, planning, ranking, operations, resource paths, payloads, prompt packs, retry queue, rendering, and types.
    - `packs/default/*`: prompt pack markdown files for judge criteria, guidance, and decomposer.
  - Rewritten for dsh:
    - `plugins/context/omd-hindsight/src/config.ts`: bridges dsh profile row into core HindsightConfig and validates through core parseConfig.
    - `plugins/context/omd-hindsight/src/runtime.ts`: manages HindsightHttpClient, backend health probing, and offline retry queue.
    - `plugins/context/omd-hindsight/src/ops.ts`: bridges execution to core executeAction and executeToolInput.
    - `plugins/context/omd-hindsight/src/tool.ts`: adapts the four-parameter tool (intent, content, file, target) to dsh tools service, omd-judgment service, request-hash cache, and subagent readonly guard.
    - `plugins/context/omd-hindsight/src/paths.ts`: exposes `hindsight://` internal paths via dsh internalPaths service using the core client and renderers.
    - `plugins/context/omd-hindsight/src/index.ts`: wires Cordis lifecycle and service injections.
    - Automatic recall follows the reference query, ranking, deduplication, and fenced payload contract. The dsh adapter records injected context through its session lifecycle.
    - The web status strip, settings and queue panels, and recall evidence cards adapt the reference terminal UI to dsh browser extension points.

  ```
  MIT License

  Copyright (c) 2026 dbydd

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
  ```

### marked (inlined in omd-context-tavern's client bundle)

- Location: `plugins/context/omd-context-tavern/src/client/index.js`, the
  "Vendored libraries" block at the top of the module factory.
- Source: <https://github.com/markedjs/marked>, version `15.0.12`, npm
  package `marked`, file `marked.min.js` (the minified UMD build).
- License: MIT, Copyright (c) 2011-2025, Christopher Jeffrey.
- Relationship: the complete minified build is inlined verbatim except for its
  trailing `sourceMappingURL` comment, so the client bundle renders markdown
  with no network fetch. The upstream license banner is kept at the head of the
  block.

  ```
  MIT License

  Copyright (c) 2011-2025, Christopher Jeffrey

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

### DOMPurify (inlined in omd-context-tavern's client bundle)

- Location: `plugins/context/omd-context-tavern/src/client/index.js`, the same
  "Vendored libraries" block, after the marked build.
- Source: <https://github.com/cure53/DOMPurify>, version `3.4.17`, npm
  package `dompurify`, file `dist/purify.min.js`.
- License: Apache-2.0 OR MPL-2.0, Copyright (c) Cure53 and other contributors.
  The upstream license banner — which names both licenses — is preserved
  verbatim at the head of the inlined block, and the full texts are at
  <https://github.com/cure53/DOMPurify/blob/3.4.17/LICENSE>.
- Relationship: the complete minified build is inlined verbatim except for its
  trailing `sourceMappingURL` comment. It sanitizes the HTML marked produces
  before that HTML reaches the DOM.

## Why GPLv3 and not a permissive license

The plugins here are not libraries others link into closed products; they are a
working agent harness meant to stay modifiable by whoever runs it. GPLv3 keeps a
downstream build — a modified plugin set, a custom desktop shell, a hosted fork
— open in the same way, and its patent and anti-lockdown clauses close the two
loopholes a permissive license leaves for this kind of software.

Combining our GPLv3 code with the MIT components above is expressly permitted:
MIT is GPLv3-compatible, and the MIT parts keep their own terms.
