// Browser half of omd-context-notes.
// Markdown notebook tab inside DS-Bot's existing details panel.
//
// Features:
// - Uses DSH platform-seeded `MarkdownText` from `@deepseek-ai/dsh-client-ui-primitives` and `react-dom/client` `createRoot`.
// - Rich Markdown view rendered by dsh's official MarkdownText pipeline (headings, emphasis, links, lists, code blocks, tables).
// - Interactive editing mode on click or Edit button, switching to exact raw markdown source editor.
// - Initial visible view is the rendered rich Markdown view.
// - Untouched source text is preserved byte-for-byte; round-trip saves use `expectedVersion` concurrency check.
// - Fixed aspect-ratio 4:3 block with an internal scrollbar: dimensions never change with content length.
// - Global DSH `--dsw-*` tokens and live en/zh locale switching via `ctx.locale`.
// - Binds strictly to the currently active main session via `ctx.sessions.list.getSnapshot()` (`retainedBy.mainView > 0`) without arbitrary first-session fallback.
// - Draft-safe against background updates; conflict alert with overwrite/discard options.
// - Strict lifecycle teardown of timers, subscriptions, React roots, and DOM nodes.

window.__ModuleLoader__.load({
  id: 'omd-context-notes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const ReactDOMClient = require('react-dom/client')
    const uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const MarkdownText = uiPrimitives?.MarkdownText
    const createRoot = ReactDOMClient?.createRoot

    const STYLE_ID = 'omd-context-notes-styles'
    const ROUTE = '/api/plugins/omd-context-notes/notes'
    const NS = 'omd-context-notes'

    // Locales
    const zh = {
      title: '上下文笔记',
      save: '保存',
      saving: '保存中...',
      saved: '已保存',
      reload: '刷新',
      modeRich: '富文本视图',
      modeSource: '编辑源码',
      edit: '编辑',
      done: '完成',
      conflict: '检测到冲突：智能体已提交新版本。',
      overwrite: '强制覆盖',
      discard: '放弃并刷新',
      noSession: '当前没有活动的会话。',
      loadError: '读取失败：',
      empty: '（暂无笔记内容，点击编辑添加）',
      placeholder: '# 共享笔记 (人机协作)\n\n在这里记录会话的背景、目标与约束...\n\n# 智能体笔记\n\n智能体执行与子任务分配区域...',
    }

    const en = {
      title: 'Context Notes',
      save: 'Save',
      saving: 'Saving...',
      saved: 'Saved',
      reload: 'Reload',
      modeRich: 'Rich View',
      modeSource: 'Edit Source',
      edit: 'Edit',
      done: 'Done',
      conflict: 'Conflict: Notes modified concurrently by agent.',
      overwrite: 'Overwrite',
      discard: 'Discard',
      noSession: 'No active session.',
      loadError: 'Failed to load: ',
      empty: '(Empty notes. Click Edit to add notes)',
      placeholder: '# Shared Notes\n\nRecord shared goals, constraints, and background here...\n\n# Agent Notes\n\nAgent working memory and allocated task notes...',
    }

    // Styles: adaptive to global DSH CSS variables
    const CSS = `
.omd-notes-widget {
  width: 100%;
  aspect-ratio: 4 / 3;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #151515);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  border-radius: var(--dsw-radius-lg, 12px);
  overflow: hidden;
  font-family: system-ui, -apple-system, sans-serif;
  transition: opacity 160ms ease, transform 160ms ease;
}

.omd-notes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-base, rgba(0, 0, 0, 0.02));
  flex-shrink: 0;
  user-select: none;
}

.omd-notes-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.omd-notes-badge {
  font-size: 11px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary, #85837f);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06));
  padding: 1px 6px;
  border-radius: 4px;
}

.omd-notes-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.omd-notes-head-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 8px;
  border-radius: var(--dsw-radius-sm, 5px);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  transition: all 120ms ease;
}
.omd-notes-head-btn:hover {
  filter: brightness(0.95);
}
.omd-notes-head-btn-primary {
  background: var(--dsw-alias-state-business-primary, #9fe3a6);
  color: #0c0d0e;
  border-color: transparent;
}
.omd-notes-head-btn-primary:hover {
  opacity: 0.92;
}
.omd-notes-head-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.omd-notes-alert {
  padding: 6px 12px;
  font-size: 11px;
  line-height: 1.4;
  flex-shrink: 0;
}
.omd-notes-alert-error {
  background: var(--dsw-alias-state-error-tertiary, rgba(224, 122, 114, 0.15));
  color: var(--dsw-alias-state-error-primary, #e07a72);
  border-bottom: 1px solid rgba(224, 122, 114, 0.3);
}
.omd-notes-alert-conflict {
  background: var(--dsw-alias-state-warn-tertiary, rgba(230, 192, 123, 0.18));
  color: var(--dsw-alias-state-warn-primary, #b58900);
  border-bottom: 1px solid rgba(230, 192, 123, 0.35);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* Scrollable container for rich and source views */
.omd-notes-body {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  position: relative;
  overflow: hidden;
  display: flex;
}

/* Rich rendered Markdown container */
.omd-notes-rich-container {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 12px 14px;
  margin: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  overflow-y: auto;
  cursor: text;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}
.omd-notes-rich-empty {
  color: var(--dsw-alias-label-tertiary, #85837f);
  font-style: italic;
  padding: 8px 0;
}

/* Source mode raw markdown textarea */
.omd-notes-source-editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 12px 14px;
  margin: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  border: 0;
  outline: none;
  resize: none;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.omd-notes-source-editor::placeholder {
  color: var(--dsw-alias-label-tertiary, #85837f);
  opacity: 0.7;
}

/* Status footer line */
.omd-notes-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #85837f);
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.05));
  background: var(--dsw-alias-bg-base, transparent);
  flex-shrink: 0;
}
`

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID)) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        const el = document.getElementById(STYLE_ID)
        if (el) el.remove()
      }
    }

    async function hostCall(body) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null) throw new Error(`notebook API returned HTTP ${response.status}`)
      if (!response.ok && payload.ok === undefined) {
        throw new Error(payload.error || `notebook API error (${response.status})`)
      }
      return payload
    }

    /** Mount one session's editor inside the existing details tab. */
    function installWidget(ctx, container, sessionId, sessionDrafts) {

      function getLocaleSnapshot() {
        const activeLocale = ctx.locale?.getSnapshot?.()?.active
        const isZh = activeLocale === 'zh'
          || (activeLocale === undefined && typeof navigator !== 'undefined' && (navigator.language || '').startsWith('zh'))
        return isZh ? zh : en
      }

      let L = getLocaleSnapshot()

      // State
      const currentSessionId = sessionId
      let disposed = false
      let cachedVersion = 0
      let committedText = ''
      let isDraftDirty = false
      let isSourceMode = false
      let pollTimer = null
      let saving = false

      const widget = document.createElement('div')
      widget.id = 'omd-notes-widget'
      widget.className = 'omd-notes-widget'

      // Header
      const head = document.createElement('div')
      head.className = 'omd-notes-head'

      const titleGroup = document.createElement('div')
      titleGroup.className = 'omd-notes-title-group'
      const titleSpan = document.createElement('span')
      titleSpan.textContent = L.title
      const versionBadge = document.createElement('span')
      versionBadge.className = 'omd-notes-badge'
      versionBadge.textContent = 'v0'
      titleGroup.append(titleSpan, versionBadge)

      const headActions = document.createElement('div')
      headActions.className = 'omd-notes-head-actions'

      const modeBtn = document.createElement('button')
      modeBtn.type = 'button'
      modeBtn.className = 'omd-notes-head-btn'
      modeBtn.textContent = L.edit
      modeBtn.title = L.modeSource

      const saveBtn = document.createElement('button')
      saveBtn.type = 'button'
      saveBtn.className = 'omd-notes-head-btn omd-notes-head-btn-primary'
      saveBtn.textContent = L.save

      headActions.append(modeBtn, saveBtn)
      head.append(titleGroup, headActions)

      // Alert bars
      const errorBar = document.createElement('div')
      errorBar.className = 'omd-notes-alert omd-notes-alert-error'
      errorBar.style.display = 'none'

      const conflictBar = document.createElement('div')
      conflictBar.className = 'omd-notes-alert omd-notes-alert-conflict'
      conflictBar.style.display = 'none'

      // Scrollable Editor Body
      const bodyContainer = document.createElement('div')
      bodyContainer.className = 'omd-notes-body'

      // Rich rendered Markdown container
      const richContainer = document.createElement('div')
      richContainer.className = 'omd-notes-rich-container'
      let richReactRoot = null
      if (createRoot) {
        richReactRoot = createRoot(richContainer)
      }

      // Source textarea
      const sourceEditor = document.createElement('textarea')
      sourceEditor.className = 'omd-notes-source-editor'
      sourceEditor.placeholder = L.placeholder
      sourceEditor.spellcheck = false
      sourceEditor.style.display = 'none'

      bodyContainer.append(richContainer, sourceEditor)

      // Footer
      const foot = document.createElement('div')
      foot.className = 'omd-notes-foot'
      const statusSpan = document.createElement('span')
      const sizeSpan = document.createElement('span')
      foot.append(statusSpan, sizeSpan)

      widget.append(head, errorBar, conflictBar, bodyContainer, foot)
      container.append(widget)

      // Helpers
      function updateStats(text) {
        const bytes = new TextEncoder().encode(text || '').length
        sizeSpan.textContent = `${bytes} B`
      }

      function getCurrentDraftText() {
        if (!isDraftDirty && committedText !== '') {
          return committedText
        }
        return sourceEditor.value
      }

      function renderRichView(text) {
        if (!text || text.trim() === '') {
          if (richReactRoot) {
            richReactRoot.render(
              React.createElement('div', { className: 'omd-notes-rich-empty' }, L.empty),
            )
          } else {
            richContainer.textContent = L.empty
          }
          return
        }

        if (MarkdownText && richReactRoot) {
          richReactRoot.render(
            React.createElement(MarkdownText, {
              text,
              variant: 'compact',
              labels: {
                code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
                footnotes: 'Footnotes',
              },
            }),
          )
        } else {
          richContainer.textContent = text
        }
      }

      function applyTextToEditors(text, markDirty = false) {
        sourceEditor.value = text
        renderRichView(text)
        updateStats(text)
      }

      function setMode(toSource) {
        isSourceMode = toSource
        if (isSourceMode) {
          richContainer.style.display = 'none'
          sourceEditor.style.display = 'block'
          modeBtn.textContent = L.done
          modeBtn.title = L.modeRich
          sourceEditor.focus()
        } else {
          sourceEditor.style.display = 'none'
          richContainer.style.display = 'block'
          modeBtn.textContent = L.edit
          modeBtn.title = L.modeSource
          renderRichView(sourceEditor.value)
        }
      }

      // Clicking on rich view allows direct transition to editing
      richContainer.onclick = () => {
        if (!isSourceMode) {
          setMode(true)
        }
      }

      modeBtn.onclick = () => {
        setMode(!isSourceMode)
      }

      function updateLocalizedLabels() {
        L = getLocaleSnapshot()
        titleSpan.textContent = L.title
        modeBtn.textContent = isSourceMode ? L.done : L.edit
        modeBtn.title = isSourceMode ? L.modeRich : L.modeSource
        saveBtn.textContent = saving ? L.saving : L.save
        sourceEditor.placeholder = L.placeholder
        if (!currentSessionId) {
          statusSpan.textContent = L.noSession
        }
        renderRichView(sourceEditor.value)
      }

      // Subscribe to live locale updates
      let unsubLocale = null
      if (typeof ctx.locale?.subscribe === 'function') {
        unsubLocale = ctx.locale.subscribe(() => {
          updateLocalizedLabels()
        })
      }

      function showError(msg) {
        if (!msg) {
          errorBar.style.display = 'none'
          errorBar.textContent = ''
        } else {
          errorBar.style.display = 'block'
          errorBar.textContent = msg
        }
      }

      function showConflict(errorMsg) {
        conflictBar.innerHTML = ''
        conflictBar.style.display = 'flex'

        const textSpan = document.createElement('span')
        textSpan.textContent = errorMsg || L.conflict

        const btnWrap = document.createElement('div')
        btnWrap.style.display = 'flex'
        btnWrap.style.gap = '6px'

        const overwrite = document.createElement('button')
        overwrite.type = 'button'
        overwrite.className = 'omd-notes-head-btn omd-notes-head-btn-primary'
        overwrite.style.padding = '2px 6px'
        overwrite.textContent = L.overwrite
        overwrite.onclick = () => {
          conflictBar.style.display = 'none'
          void doSave(true)
        }

        const discard = document.createElement('button')
        discard.type = 'button'
        discard.className = 'omd-notes-head-btn'
        discard.style.padding = '2px 6px'
        discard.textContent = L.discard
        discard.onclick = () => {
          conflictBar.style.display = 'none'
          isDraftDirty = false
          sessionDrafts.delete(currentSessionId)
          void fetchNotes(currentSessionId)
        }

        btnWrap.append(overwrite, discard)
        conflictBar.append(textSpan, btnWrap)
      }

      async function fetchNotes(sessionId) {
        if (!sessionId) {
          applyTextToEditors('', false)
          statusSpan.textContent = L.noSession
          return
        }
        statusSpan.textContent = ''
        showError(null)

        const requestedSessionId = sessionId
        try {
          const res = await hostCall({ op: 'read', sessionId })
          if (disposed || requestedSessionId !== currentSessionId) return

          if (res?.state || res?.fullText !== undefined) {
            const version = res.state ? res.state.version : res.version
            const text = res.state ? (res.state.text ?? '') : (res.fullText ?? '')
            cachedVersion = version
            versionBadge.textContent = `v${cachedVersion}`
            committedText = text

            // If draft dirty, keep draft intact
            const draft = sessionDrafts.get(sessionId)
            if (draft && draft.dirty) {
              cachedVersion = draft.version
              isDraftDirty = true
              applyTextToEditors(draft.text, true)
              if (version !== draft.version) showConflict(L.conflict)
            } else if (!isDraftDirty) {
              applyTextToEditors(committedText, false)
            }
          }
        } catch (err) {
          if (!disposed && requestedSessionId === currentSessionId) {
            showError(`${L.loadError}${err.message}`)
          }
        }
      }

      async function doSave(force = false) {
        const targetSessionId = currentSessionId
        if (!targetSessionId || saving) return
        saving = true
        saveBtn.disabled = true
        saveBtn.textContent = L.saving
        showError(null)
        conflictBar.style.display = 'none'

        try {
          const textToSave = getCurrentDraftText()
          const payload = {
            op: 'save',
            sessionId: targetSessionId,
            text: textToSave,
            section: 'full',
            ...(!force ? { expectedVersion: cachedVersion } : {}),
          }
          const res = await hostCall(payload)
          if (res?.ok === false) {
            if (res.stale || res.error?.includes('conflict') || res.error?.includes('stale') || res.error?.includes('version')) {
              showConflict(res.error)
            } else {
              showError(res.error || 'Save failed')
            }
          } else {
            if (res?.state) {
              cachedVersion = res.state.version
              versionBadge.textContent = `v${cachedVersion}`
              committedText = res.state.text
            }
            isDraftDirty = false
            sessionDrafts.delete(targetSessionId)
            renderRichView(committedText)
            saveBtn.textContent = L.saved
            setTimeout(() => {
              saveBtn.textContent = L.save
            }, 1200)
          }
        } catch (err) {
          showError(err.message)
        } finally {
          saving = false
          saveBtn.disabled = false
          if (saveBtn.textContent === L.saving) {
            saveBtn.textContent = L.save
          }
        }
      }

      // Input listeners
      sourceEditor.addEventListener('input', () => {
        isDraftDirty = true
        const text = sourceEditor.value
        if (currentSessionId) {
          sessionDrafts.set(currentSessionId, { text, dirty: true, version: cachedVersion })
        }
        updateStats(text)
      })

      const onEditorKeyDown = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          void doSave()
        }
      }
      sourceEditor.addEventListener('keydown', onEditorKeyDown)

      saveBtn.onclick = () => void doSave()

      void fetchNotes(currentSessionId)
      pollTimer = setInterval(() => {
        if (!isDraftDirty && !saving && currentSessionId) void fetchNotes(currentSessionId)
      }, 3000)

      return () => {
        disposed = true
        if (pollTimer) clearInterval(pollTimer)
        if (unsubLocale) unsubLocale()
        if (richReactRoot) queueMicrotask(() => richReactRoot.unmount())
        widget.remove()
      }
    }

    function apply(ctx) {
      ctx.effect(installStyles, 'omd-context-notes: stylesheet')
      ctx.effect(() => ctx.locale?.register?.(NS, { en, zh }), 'omd-context-notes: dictionaries')
      const drafts = new Map()
      function NotesTab({ sessionId, bot, room }) {
        const container = React.useRef(null)
        const owned = Boolean(bot || room)
        React.useEffect(() => {
          if (owned) return installWidget(ctx, container.current, sessionId, drafts)
        }, [sessionId, owned])
        return owned ? React.createElement('div', { ref: container, className: 'omd-notes-tab' }) : null
      }
      function NotesLabel() {
        const active = React.useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        return (active === 'zh' ? zh : en).title
      }
      ctx.effect(() => {
        let cancelled = false
        let dispose
        const register = hub => {
          if (!cancelled) dispose = hub.registerDetailsTab({ id: 'omd-context-notes', label: NotesLabel, component: NotesTab })
        }
        if (window.dshBot) register(window.dshBot)
        else (window.dshBotQueue ??= []).push(register)
        return () => {
          cancelled = true
          dispose?.()
          drafts.clear()
        }
      }, 'omd-context-notes: details tab')
    }

    exports.inject = ['locale']
    exports.apply = apply
    return module.exports
  },
})
