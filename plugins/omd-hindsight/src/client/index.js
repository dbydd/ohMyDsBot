// Browser half of omd-hindsight. Hand-authored plain JavaScript: the web shell
// splices these bytes into its module loader, so only platform modules may be
// required and there is no build step.
//
// Three surfaces, all fed by the host's one `hindsight` internal source:
// 1. A compact status strip docked above the composer. It reads
//    `hindsight://plugin/status` every five seconds and never draws a token
//    percentage: Hindsight state is not context-window occupancy.
// 2. A console overlay with 配置 / 队列 tabs. The configuration form is built
//    from the host's JSON Schema and saves a sparse override against the
//    project revision it read; the queue tab lists real entries and resends
//    through the same action channel the model uses.
// 3. A dedicated conversation card for injected recall facts. The card reads
//    `source.details` from the durable session event, never the message body,
//    and its evidence links open read-only internal resources through
//    `/api/paths`.
window.__ModuleLoader__.load({
  id: 'omd-hindsight',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const ReactDOM = require('react-dom')
    const ReactDOMClient = require('react-dom/client')
    const { createElement: h } = React
    const createPortal = ReactDOM.createPortal ?? ReactDOMClient.createPortal
    const MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText

    const NS = 'omd.hindsight'
    const CARD_KIND = 'omdHindsightRecall'
    const CHAT_SLOT = 'conversation.chat.node'
    const DOCK_SLOT = 'conversation.input.dock'
    const STYLE_OWNER = 'omd-hindsight/client'
    const PATHS_ROUTE = '/api/paths'
    const STATUS_URI = 'hindsight://plugin/status'
    const CONFIG_URI = 'hindsight://plugin/project-config'
    const QUEUE_URI = 'hindsight://plugin/queue'
    const POLL_MS = 5000
    const CARD_HEADER = 'HINDSIGHT CONTEXT GUIDELINES'
    const SAVE_INTENT = 'Update Hindsight project settings'
    const RETRY_INTENT = 'Retry queued Hindsight memory writes'

    const en = {
      'bar.name': 'Hindsight',
      'bar.connected': 'Connected',
      'bar.degraded': 'Degraded',
      'bar.unconfigured': 'Unconfigured',
      'bar.reading': 'reading…',
      'bar.banks': 'Banks',
      'bar.queue': 'Retain Queue',
      'bar.settings': 'Settings',
      'bar.queueButton': 'Queue',
      'bar.unknown': '—',
      'bar.healthDetail': 'Connection status',
      'console.title': 'Hindsight Console',
      'console.tab.config': 'Configuration',
      'console.tab.queue': 'Retry Queue',
      'console.close': 'Close',
      'console.refresh': 'Refresh',
      'console.loading': 'Reading internal resources…',
      'console.readFailed': 'Could not read',
      'console.retryRead': 'Retry',
      'console.statusNote': 'Hindsight status',
      'console.project': 'Project',
      'console.revision': 'Revision',
      'config.hint': 'Only changed fields are written, against the revision shown above.',
      'config.saved': 'Configuration saved.',
      'config.noChanges': 'No changed fields to save.',
      'config.conflict': 'The project configuration changed since this form was read. Reload to adopt the current revision; the draft is kept.',
      'config.reload': 'Reload',
      'config.noFields': 'The host published no editable properties in its schema.',
      'config.override': 'project override',
      'config.number': 'Must be a number',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'queue.empty': 'The retry queue is empty.',
      'queue.corrupt': 'Corrupt entries',
      'queue.attempts': 'attempts',
      'queue.lastError': 'Last error',
      'queue.retry': 'Resend now',
      'queue.retrying': 'Resending…',
      'queue.result': 'Sent {sent}, still queued {queued}, failed {failed}, corrupt {corrupt}.',
      'queue.failedRetry': 'Resend failed',
      'queue.evidence': 'Open internal evidence',
      'card.banks': 'bank',
      'card.antiPattern': 'Anti-pattern',
      'card.unknownType': 'unknown',
      'card.query': 'Query',
      'card.fence': 'Fence',
      'preview.title': 'Read-only evidence',
      'preview.close': 'Close',
      'preview.loading': 'Reading…',
      'preview.failed': 'Evidence could not be read',
    }

    const zh = {
      'bar.name': 'Hindsight',
      'bar.connected': '已连接',
      'bar.degraded': '服务异常',
      'bar.unconfigured': '未配置',
      'bar.reading': '读取中…',
      'bar.banks': 'Banks',
      'bar.queue': 'Retain Queue',
      'bar.settings': '设置',
      'bar.queueButton': '队列',
      'bar.unknown': '—',
      'bar.healthDetail': '连接状态',
      'console.title': 'Hindsight 控制台',
      'console.tab.config': '配置',
      'console.tab.queue': '重试队列',
      'console.close': '关闭',
      'console.refresh': '刷新',
      'console.loading': '正在读取内部资源…',
      'console.readFailed': '读取失败',
      'console.retryRead': '重试',
      'console.statusNote': 'Hindsight 状态',
      'console.project': '项目',
      'console.revision': '修订',
      'config.hint': '仅提交改动的字段，并按上方修订号做并发校验。',
      'config.saved': '配置已保存。',
      'config.noChanges': '没有改动的字段。',
      'config.conflict': '项目配置已在此表单读取后被修改。重新载入可获取当前修订，草稿会保留。',
      'config.reload': '重新载入',
      'config.noFields': '宿主没有在 schema 中声明可编辑字段。',
      'config.override': '项目覆盖',
      'config.number': '必须是数字',
      'config.save': '保存',
      'config.saving': '保存中…',
      'queue.empty': '重试队列为空。',
      'queue.corrupt': '损坏条目',
      'queue.attempts': '次尝试',
      'queue.lastError': '最近错误',
      'queue.retry': '立即重发',
      'queue.retrying': '重发中…',
      'queue.result': '已发送 {sent}，仍在队列 {queued}，失败 {failed}，损坏 {corrupt}。',
      'queue.failedRetry': '重发失败',
      'queue.evidence': '打开内部证据',
      'card.banks': '记忆库',
      'card.antiPattern': '反模式',
      'card.unknownType': '未知类型',
      'card.query': '查询',
      'card.fence': '围栏',
      'preview.title': '只读证据',
      'preview.close': '关闭',
      'preview.loading': '读取中…',
      'preview.failed': '证据读取失败',
    }

    const CSS = `
.omd-hs-strip, .omd-hs-console, .omd-hs-card, .omd-hs-preview {
  --omd-hs-border: var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.28));
  --omd-hs-muted: var(--dsw-alias-label-tertiary, #8a8a8a);
  --omd-hs-secondary: var(--dsw-alias-label-secondary, #6b6b6b);
  --omd-hs-primary: var(--dsw-alias-label-primary, inherit);
  --omd-hs-surface: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff));
  --omd-hs-soft: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  --omd-hs-accent: var(--bt-accent, #4d6bfe);
  --omd-hs-ok: var(--dsw-static-success-400, #3fbf7f);
  --omd-hs-warn: var(--dsw-alias-state-warning-primary, #d9973f);
  --omd-hs-error: var(--dsw-alias-state-error-primary, #d64545);
}
.omd-hs-strip *, .omd-hs-console *, .omd-hs-card *, .omd-hs-preview * { box-sizing: border-box; }
.omd-hs-strip button, .omd-hs-console button, .omd-hs-card button, .omd-hs-preview button {
  font: inherit; color: inherit; background: none; border: none; cursor: pointer;
}

/* ================= Status strip above the composer ================= */
[data-slot='conversation.input.dock']:has(.omd-hs-strip) {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  width: 100% !important;
  box-sizing: border-box !important;
}
.omd-hs-strip {
  width: 100%;
  max-width: min(992px, 100%);
  margin: 0 auto 4px;
  padding: 2px 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--omd-hs-secondary);
}
.omd-hs-lede, .omd-hs-stat { display: inline-flex; align-items: center; gap: 5px; min-width: 0; white-space: nowrap; }
.omd-hs-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--omd-hs-muted); }
.omd-hs-dot[data-tone='ok'] { background: var(--omd-hs-ok); }
.omd-hs-dot[data-tone='warn'] { background: var(--omd-hs-warn); }
.omd-hs-dot[data-tone='off'] { background: var(--omd-hs-muted); }
.omd-hs-name { font-weight: 600; color: var(--omd-hs-primary); }
.omd-hs-state[data-tone='ok'] { color: var(--omd-hs-ok); }
.omd-hs-state[data-tone='warn'] { color: var(--omd-hs-warn); }
.omd-hs-flag {
  flex: none; width: 14px; height: 14px; padding: 0;
  border-radius: 50%; font-size: 10px; font-weight: 700; line-height: 14px;
  text-align: center; color: var(--omd-hs-warn);
  background: color-mix(in srgb, var(--omd-hs-warn) 18%, transparent);
}
.omd-hs-sep { width: 1px; height: 12px; flex: none; background: var(--omd-hs-border); }
.omd-hs-banks, .omd-hs-queue {
  font-variant-numeric: tabular-nums;
}
.omd-hs-banks-names {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: min(220px, 30vw); color: var(--omd-hs-muted);
}
.omd-hs-queue[data-alert='true'] { color: var(--omd-hs-warn); }
.omd-hs-spacer { flex: 1 1 8px; min-width: 0; }
.omd-hs-actions { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.omd-hs-action {
  padding: 2px 9px; border-radius: 999px;
  border: 0.5px solid var(--omd-hs-border);
  color: var(--omd-hs-secondary); font-size: 11px; white-space: nowrap;
}
.omd-hs-action:hover { background: var(--omd-hs-soft); color: var(--omd-hs-primary); }
.omd-hs-action:focus-visible { outline: 2px solid var(--omd-hs-accent); outline-offset: 1px; }
@media (max-width: 560px) {
  .omd-hs-sep { display: none; }
  .omd-hs-banks-names { max-width: 26vw; }
  .omd-hs-spacer { flex-basis: 100%; height: 0; }
  .omd-hs-actions { margin-left: auto; }
}

/* ================= Console overlay ================= */
.omd-hs-console-backdrop {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(0, 0, 0, 0.34);
}
.omd-hs-console {
  position: fixed; z-index: 9001;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(760px, calc(100vw - 32px));
  max-height: min(720px, calc(100vh - 48px));
  display: flex; flex-direction: column;
  border: 0.5px solid var(--omd-hs-border);
  border-radius: 14px;
  background: var(--omd-hs-surface);
  color: var(--omd-hs-primary);
  box-shadow: 0 18px 56px rgba(0, 0, 0, 0.28);
  font-size: 12px;
  overflow: hidden;
}
.omd-hs-console-head {
  display: flex; align-items: center; gap: 10px; flex: none;
  padding: 12px 16px; border-bottom: 0.5px solid var(--omd-hs-border);
}
.omd-hs-console-title { font-size: 14px; font-weight: 600; }
.omd-hs-console-meta { color: var(--omd-hs-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omd-hs-head-actions { margin-left: auto; display: inline-flex; gap: 6px; flex: none; }
.omd-hs-btn {
  padding: 4px 10px; border: 0.5px solid var(--omd-hs-border); border-radius: 7px;
  font-size: 11px; color: var(--omd-hs-secondary);
}
.omd-hs-btn:hover:not(:disabled) { background: var(--omd-hs-soft); color: var(--omd-hs-primary); }
.omd-hs-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.omd-hs-btn[data-primary='true'] { border-color: var(--omd-hs-accent); color: var(--omd-hs-accent); }
.omd-hs-tabs { display: inline-flex; gap: 4px; padding: 8px 16px 0; flex: none; }
.omd-hs-tab {
  padding: 5px 12px; border-radius: 8px 8px 0 0;
  color: var(--omd-hs-muted); font-size: 12px;
}
.omd-hs-tab[data-active='true'] { color: var(--omd-hs-primary); background: var(--omd-hs-soft); font-weight: 600; }
.omd-hs-console-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px 18px; }
.omd-hs-notice { padding: 8px 10px; border-radius: 8px; margin-bottom: 10px; overflow-wrap: anywhere; }
.omd-hs-notice[data-tone='error'] { color: var(--omd-hs-error); background: color-mix(in srgb, var(--omd-hs-error) 10%, transparent); }
.omd-hs-notice[data-tone='warning'] { color: var(--omd-hs-warn); background: color-mix(in srgb, var(--omd-hs-warn) 10%, transparent); }
.omd-hs-notice[data-tone='success'] { color: var(--omd-hs-ok); }
.omd-hs-conflict {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  padding: 9px 10px; margin-bottom: 12px;
  border: 0.5px solid var(--omd-hs-warn); border-radius: 8px;
  color: var(--omd-hs-warn); overflow-wrap: anywhere;
}
.omd-hs-conflict-text { flex: 1 1 240px; }
.omd-hs-loading, .omd-hs-empty { color: var(--omd-hs-muted); padding: 16px 0; }
.omd-hs-section-hint { color: var(--omd-hs-muted); margin-bottom: 12px; line-height: 1.5; }

/* ================= Schema-driven form ================= */
.omd-hs-form { display: flex; flex-direction: column; gap: 12px; }
.omd-hs-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.omd-hs-field-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.omd-hs-field-title { font-weight: 600; overflow-wrap: anywhere; }
.omd-hs-field-key { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); color: var(--omd-hs-muted); font-size: 11px; }
.omd-hs-field-override { font-size: 10px; color: var(--omd-hs-accent); }
.omd-hs-field-desc { color: var(--omd-hs-muted); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.omd-hs-field-value {
  margin: 0; padding: 6px 9px; border-radius: 7px;
  background: var(--omd-hs-soft); color: var(--omd-hs-secondary);
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 120px; overflow: auto;
}
.omd-hs-input, .omd-hs-select {
  width: 100%; max-width: 100%; padding: 6px 9px;
  border: 0.5px solid var(--omd-hs-border); border-radius: 7px;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--omd-hs-primary); font: inherit; font-size: 12px;
}
.omd-hs-input:focus, .omd-hs-select:focus { outline: 2px solid var(--omd-hs-accent); outline-offset: 0; }
.omd-hs-checkbox { width: 15px; height: 15px; accent-color: var(--omd-hs-accent); }
.omd-hs-form-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }

/* ================= Queue ================= */
.omd-hs-queue-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.omd-hs-queue-list { display: flex; flex-direction: column; gap: 8px; }
.omd-hs-queue-rows { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.omd-hs-queue-row {
  display: flex; flex-direction: column; gap: 4px;
  padding: 8px 10px; border: 0.5px solid var(--omd-hs-border); border-radius: 9px;
  min-width: 0;
}
.omd-hs-queue-row[data-state='failed'] { border-color: color-mix(in srgb, var(--omd-hs-error) 55%, transparent); }
.omd-hs-queue-row-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; }
.omd-hs-queue-bank { font-weight: 600; }
.omd-hs-queue-chip { color: var(--omd-hs-muted); font-size: 11px; }
.omd-hs-queue-error { color: var(--omd-hs-error); overflow-wrap: anywhere; font-size: 11px; }
.omd-hs-link {
  align-self: flex-start; padding: 0; font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  font-size: 11px; color: var(--omd-hs-accent); text-align: left;
  overflow-wrap: anywhere; word-break: break-all;
}
.omd-hs-link:hover { text-decoration: underline; }
.omd-hs-subhead { color: var(--omd-hs-muted); font-size: 11px; margin: 8px 0 2px; }

/* ================= Injected recall card ================= */
.omd-hs-card {
  display: flex; flex-direction: column; gap: 8px;
  margin: 4px 0; padding: 9px 12px;
  border: 0.5px solid color-mix(in srgb, var(--omd-hs-accent) 42%, transparent);
  border-left: 3px solid var(--omd-hs-accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--omd-hs-accent) 6%, var(--omd-hs-surface));
  color: var(--omd-hs-primary);
  font-size: 12px;
  min-width: 0;
}
.omd-hs-card-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.omd-hs-card-mark { color: var(--omd-hs-accent); }
.omd-hs-card-title {
  color: var(--omd-hs-accent); font-size: 11px; font-weight: 700;
  letter-spacing: 0.06em;
}
.omd-hs-card-banks { color: var(--omd-hs-muted); font-size: 11px; overflow-wrap: anywhere; }
.omd-hs-bank-chip {
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  padding: 0 5px; margin-right: 4px; border-radius: 999px;
  background: color-mix(in srgb, var(--omd-hs-accent) 12%, transparent);
}
.omd-hs-card-facts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.omd-hs-fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.omd-hs-fact-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.omd-hs-fact-type {
  flex: none; font-size: 10px; color: var(--omd-hs-muted);
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
}
.omd-hs-fact-text {
  overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  line-height: 1.45; overflow-wrap: anywhere;
}
.omd-hs-fact[data-anti='true'] {
  padding: 5px 8px; border-radius: 7px;
  background: color-mix(in srgb, var(--omd-hs-warn) 12%, transparent);
  color: var(--omd-hs-warn);
}
.omd-hs-fact[data-anti='true'] .omd-hs-fact-type { color: var(--omd-hs-warn); font-weight: 700; }
.omd-hs-fact[data-anti='true'] .omd-hs-link { color: var(--omd-hs-warn); }
.omd-hs-card-foot {
  border-top: 0.5px solid var(--omd-hs-border); padding-top: 6px;
  display: flex; gap: 8px; flex-wrap: wrap; color: var(--omd-hs-muted); font-size: 11px;
}
.omd-hs-card-foot span { min-width: 0; overflow-wrap: anywhere; }

/* ================= Read-only evidence preview ================= */
.omd-hs-preview-backdrop { position: fixed; inset: 0; z-index: 9100; background: rgba(0, 0, 0, 0.34); }
.omd-hs-preview {
  position: fixed; z-index: 9101;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(680px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 48px));
  display: flex; flex-direction: column;
  border: 0.5px solid var(--omd-hs-border); border-radius: 12px;
  background: var(--omd-hs-surface); color: var(--omd-hs-primary);
  box-shadow: 0 18px 56px rgba(0, 0, 0, 0.28); font-size: 12px; overflow: hidden;
}
.omd-hs-preview-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 0.5px solid var(--omd-hs-border);
}
.omd-hs-preview-title { font-weight: 600; }
.omd-hs-preview-uri {
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  font-size: 11px; color: var(--omd-hs-muted); overflow-wrap: anywhere; min-width: 0;
}
.omd-hs-preview-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px 14px 16px; }
.omd-hs-preview-body pre {
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px;
  line-height: 1.5;
}
.omd-hs-preview-error { color: var(--omd-hs-error); overflow-wrap: anywhere; }
`

    /** Install the stylesheet once; the plugin's fiber owns its lifetime. */
    function installStyles() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_OWNER}"]`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.pluginCss = STYLE_OWNER
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    /** Localized copy, re-read live from the platform's locale service. */
    function useDict(ctx) {
      const subscribe = React.useCallback(listener => {
        const locale = ctx.locale
        return typeof locale?.subscribe === 'function' ? locale.subscribe(listener) : () => {}
      }, [ctx])
      const read = React.useCallback(() => {
        const locale = ctx.locale
        const active = typeof locale?.getSnapshot === 'function' ? locale.getSnapshot()?.active : undefined
        if (active === 'zh') return zh
        if (active === 'en') return en
        return typeof navigator !== 'undefined' && String(navigator.language ?? '').startsWith('zh') ? zh : en
      }, [ctx])
      const dict = React.useSyncExternalStore(subscribe, read, read)
      return React.useCallback((key, values) => {
        const text = dict[key] ?? en[key] ?? key
        if (values === undefined) return text
        return text.replace(/\{(\w+)\}/g, (found, name) =>
          Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : found)
      }, [dict])
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function reasonOf(body, response) {
      if (typeof body === 'object' && body !== null && typeof body.error === 'string' && body.error !== '') return body.error
      return `${PATHS_ROUTE} → ${response.status}`
    }

    /** Parse a transport answer without insisting on a particular status code. */
    async function parseResponse(response) {
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = undefined }
      if (!response.ok) throw new Error(reasonOf(body, response))
      return body === undefined ? text : body
    }

    function pathsUrl(uri, sessionId) {
      const query = new URLSearchParams({ uri })
      if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId)
      return `${PATHS_ROUTE}?${query.toString()}`
    }

    /** The session a slot entry is mounted for: the standard prop or the input-zone owner. */
    function sessionIdOf(props) {
      if (typeof props?.sessionId === 'string' && props.sessionId !== '') return props.sessionId
      const session = props?.session
      return session !== null && typeof session === 'object' && typeof session.id === 'string' ? session.id : ''
    }

    /** Read one internal address through the browser's own channel. */
    async function readPath(uri, sessionId, signal) {
      const response = await fetch(pathsUrl(uri, sessionId), {
        headers: { accept: 'application/json' },
        ...(signal !== undefined ? { signal } : {}),
      })
      return parseResponse(response)
    }

    /** Submit an action to the same internal address. */
    async function submitPath(uri, payload, sessionId, signal) {
      const response = await fetch(pathsUrl(uri, sessionId), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        ...(signal !== undefined ? { signal } : {}),
      })
      return parseResponse(response)
    }

    /** The three states the strip can honestly report. */
    function statusOf(body) {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { state: 'unconfigured', error: 'status resource returned no object' }
      }
      if (body.enabled !== true) return { state: 'unconfigured', error: '' }
      const health = typeof body.health === 'object' && body.health !== null ? body.health : {}
      return {
        state: health.healthy === true ? 'connected' : 'degraded',
        error: typeof health.error === 'string' ? health.error : '',
        version: typeof health.version === 'string' ? health.version : '',
      }
    }

    function bankNames(body) {
      if (typeof body !== 'object' || body === null || !Array.isArray(body.banks)) return []
      return body.banks.map(bank => {
        if (typeof bank === 'string') return bank
        if (typeof bank !== 'object' || bank === null) return ''
        if (typeof bank.id === 'string' && bank.id !== '') return bank.id
        return typeof bank.bankId === 'string' ? bank.bankId : ''
      }).filter(name => name !== '')
    }

    function queueCount(body) {
      const queue = typeof body === 'object' && body !== null ? body.queue : undefined
      if (typeof queue !== 'object' || queue === null) return undefined
      return Number.isFinite(queue.pending) ? queue.pending : undefined
    }

    /** A queued entry's own read-only resource in the host's resource tree. */
    function queueEntryPath(entry) {
      return `hindsight://queue/${encodeURIComponent(String(entry.id))}`
    }

    function isConflict(answer) {
      if (typeof answer !== 'object' || answer === null) return false
      if (answer.ok === false) {
        return answer.stale === true || typeof answer.currentRevision === 'number'
          || /revision|conflict|stale/i.test(String(answer.error ?? ''))
      }
      return false
    }

    function initialOf(effective, schema) {
      const result = {}
      const properties = typeof schema === 'object' && schema !== null
        && typeof schema.properties === 'object' && schema.properties !== null
        ? schema.properties : {}
      for (const key of Object.keys(properties)) {
        const property = properties[key] ?? {}
        const current = effective != null && typeof effective === 'object' ? effective[key] : undefined
        if (current === undefined || current === null) {
          result[key] = property.type === 'boolean' ? false : ''
        } else if (typeof current === 'boolean') {
          result[key] = current
        } else if (typeof current === 'object') {
          result[key] = JSON.stringify(current)
        } else {
          result[key] = String(current)
        }
      }
      return result
    }

    function sameValue(left, right) {
      return String(left) === String(right)
    }

    const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

    /** Only a scalar or an enum can be round-tripped through a form control. */
    function isEditable(property) {
      if (property === null || typeof property !== 'object') return false
      if (Array.isArray(property.enum)) return true
      return SCALAR_TYPES.has(property.type)
    }

    /** Schema-typed value for one changed field; null means invalid input. */
    function typedValue(property, raw) {
      if (Array.isArray(property.enum)) {
        const member = property.enum.find(option => String(option) === String(raw))
        return member === undefined ? String(raw) : member
      }
      const type = property.type
      if (type === 'boolean') return Boolean(raw)
      if (type === 'number' || type === 'integer') {
        if (String(raw).trim() === '') return ''
        const number = Number(raw)
        if (!Number.isFinite(number)) return null
        if (type === 'integer' && !Number.isInteger(number)) return null
        if (Number.isFinite(property.minimum) && number < property.minimum) return null
        if (Number.isFinite(property.maximum) && number > property.maximum) return null
        return number
      }
      return String(raw)
    }

    function reportOf(answer) {
      const body = typeof answer === 'object' && answer !== null ? answer : {}
      const raw = body.report && typeof body.report === 'object' ? body.report : body
      const count = key => Array.isArray(raw[key]) ? raw[key].length : 0
      return { sent: count('sent'), queued: count('queued'), failed: count('failed'), corrupt: count('corrupt') }
    }

    // ------------------------------------------------------------------
    // Status strip and console.
    // ------------------------------------------------------------------

    function HindsightStrip(props) {
      const t = useDict(pluginCtx)
      const sessionId = sessionIdOf(props)
      const [view, setView] = React.useState({ phase: 'loading' })
      const [consoleTab, setConsoleTab] = React.useState(null)
      const [refreshKey, setRefreshKey] = React.useState(0)

      React.useEffect(() => {
        let live = true
        let inflight = false
        const controller = new AbortController()
        const read = async () => {
          if (inflight || controller.signal.aborted) return
          inflight = true
          const requestedSession = sessionId
          try {
            const body = await readPath(STATUS_URI, requestedSession, controller.signal)
            if (!live || requestedSession !== sessionId) return
            const status = statusOf(body)
            setView({
              phase: 'ready',
              state: status.state,
              error: status.error,
              version: status.version,
              names: bankNames(body),
              pending: queueCount(body),
            })
          } catch (error) {
            if (!live || controller.signal.aborted || requestedSession !== sessionId) return
            setView({ phase: 'error', state: 'unconfigured', error: messageOf(error), names: [], pending: undefined })
          } finally {
            inflight = false
          }
        }
        void read()
        const timer = setInterval(() => { void read() }, POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
          controller.abort()
        }
      }, [sessionId, refreshKey])

      const state = view.phase === 'ready' ? view.state : view.phase === 'loading' ? 'loading' : 'unconfigured'
      const tone = state === 'connected' ? 'ok' : state === 'degraded' ? 'warn' : 'off'
      const label = state === 'connected' ? t('bar.connected')
        : state === 'degraded' ? t('bar.degraded')
          : state === 'loading' ? t('bar.reading') : t('bar.unconfigured')
      const title = [t('bar.healthDetail'), view.error, view.version].filter(part => typeof part === 'string' && part !== '').join(' · ')
      const pending = view.pending
      const alert = typeof pending === 'number' && pending > 0
      const banksKnown = view.phase === 'ready' && Array.isArray(view.names)
      const names = banksKnown ? view.names : []
      const statusProblem = view.phase === 'error'
        ? view.error
        : view.state === 'degraded' && view.error ? view.error : ''

      const open = tab => { setConsoleTab(tab) }

      return h('div', {
        className: 'omd-hs-strip', 'data-hs-part': 'bar', 'data-state': state,
        role: 'group', title,
      },
      h('span', { className: 'omd-hs-lede' },
        h('span', { className: 'omd-hs-dot', 'data-hs-part': 'dot', 'data-tone': tone }),
        h('span', { className: 'omd-hs-name' }, t('bar.name')),
        h('span', { className: 'omd-hs-state', 'data-tone': tone }, label),
        statusProblem !== ''
          ? h('button', {
            type: 'button', className: 'omd-hs-flag', 'data-hs-part': 'status-flag',
            title: statusProblem, 'aria-label': statusProblem,
            onClick: () => open('config'),
          }, '!')
          : null),
      h('span', { className: 'omd-hs-sep', 'aria-hidden': 'true' }),
      h('span', { className: 'omd-hs-stat omd-hs-banks', 'data-hs-part': 'banks' },
        `${t('bar.banks')} ${banksKnown ? names.length : t('bar.unknown')}`,
        banksKnown
          ? h('span', {
            className: 'omd-hs-banks-names', 'data-hs-part': 'banks-names',
            title: names.length > 0 ? names.join(', ') : '',
          }, names.length > 0 ? `(${names.join(', ')})` : t('bar.unknown'))
          : null),
      h('span', {
        className: 'omd-hs-stat omd-hs-queue', 'data-hs-part': 'queue',
        'data-alert': alert ? 'true' : 'false',
        title: view.error && state === 'unconfigured' ? view.error : undefined,
      },
      `${t('bar.queue')} ${typeof pending === 'number' ? pending : t('bar.unknown')}`),
      h('span', { className: 'omd-hs-spacer' }),
      h('span', { className: 'omd-hs-actions' },
        h('button', {
          type: 'button', className: 'omd-hs-action omd-hs-btn-settings',
          'data-hs-part': 'settings', onClick: () => open('config'),
        }, t('bar.settings')),
        h('button', {
          type: 'button', className: 'omd-hs-action omd-hs-btn-queue',
          'data-hs-part': 'queue-button', onClick: () => open('queue'),
        }, t('bar.queueButton'))),
      consoleTab !== null
        ? createPortal(h(HindsightConsole, {
          sessionId, initialTab: consoleTab, statusProblem, t,
          onClose: () => { setConsoleTab(null); setRefreshKey(value => value + 1) },
        }), document.body)
        : null)
    }

    function HindsightConsole({ sessionId, initialTab, statusProblem, onClose, t }) {
      const [tab, setTab] = React.useState(initialTab)
      const [config, setConfig] = React.useState({ phase: 'loading' })
      const [draft, setDraft] = React.useState({})
      const [queue, setQueue] = React.useState({ phase: 'loading' })
      const [saving, setSaving] = React.useState(false)
      const [retrying, setRetrying] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [retryResult, setRetryResult] = React.useState(null)
      const [conflict, setConflict] = React.useState(null)
      const [reloadKey, setReloadKey] = React.useState(0)
      const [queueReloadKey, setQueueReloadKey] = React.useState(0)
      const controller = React.useRef(null)
      const mounted = React.useRef(true)
      const keepDraft = React.useRef(false)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          controller.current?.abort()
        }
      }, [])

      React.useEffect(() => {
        const onKey = event => {
          if (event.key !== 'Escape') return
          // The evidence overlay is portaled outside this tree and owns Escape
          // while it is open; closing both at once would discard the reader's place.
          if (document.querySelector('.omd-hs-preview') !== null) return
          onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const loadConfig = React.useCallback(async (signal) => {
        try {
          const body = await readPath(CONFIG_URI, sessionId, signal)
          if (!mounted.current) return
          const schema = typeof body === 'object' && body !== null ? body.schema : undefined
          const effective = typeof body === 'object' && body !== null ? body.effective : undefined
          const revision = typeof body === 'object' && body !== null && Number.isFinite(body.revision)
            ? body.revision : undefined
          if (typeof body !== 'object' || body === null || revision === undefined) {
            throw new Error('project-config resource did not carry a revision')
          }
          setConfig({ phase: 'ready', schema, effective, revision, project: body.project, values: body.values })
          setDraft(previous => {
            if (!keepDraft.current) return initialOf(effective, schema)
            const next = initialOf(effective, schema)
            for (const key of Object.keys(previous)) {
              if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = previous[key]
            }
            return next
          })
          keepDraft.current = false
          setConflict(null)
        } catch (error) {
          if (!mounted.current || signal.aborted) return
          setConfig({ phase: 'error', error: messageOf(error) })
        }
      }, [sessionId])

      const loadQueue = React.useCallback(async (signal) => {
        try {
          const body = await readPath(QUEUE_URI, sessionId, signal)
          if (!mounted.current) return
          const snapshot = typeof body === 'object' && body !== null && body.snapshot
            && typeof body.snapshot === 'object' ? body.snapshot : body
          if (typeof snapshot !== 'object' || snapshot === null
            || !Array.isArray(snapshot.pending) || !Array.isArray(snapshot.failed)) {
            throw new Error('queue resource did not carry pending and failed entries')
          }
          setQueue({ phase: 'ready', snapshot })
        } catch (error) {
          if (!mounted.current || signal.aborted) return
          setQueue({ phase: 'error', error: messageOf(error) })
        }
      }, [sessionId])

      React.useEffect(() => {
        const current = new AbortController()
        controller.current = current
        setConfig({ phase: 'loading' })
        void loadConfig(current.signal)
        return () => current.abort()
      }, [loadConfig, reloadKey])

      React.useEffect(() => {
        const current = new AbortController()
        setQueue({ phase: 'loading' })
        void loadQueue(current.signal)
        return () => current.abort()
      }, [loadQueue, queueReloadKey])

      const properties = config.phase === 'ready' && typeof config.schema === 'object' && config.schema !== null
        && typeof config.schema.properties === 'object' && config.schema.properties !== null
        ? config.schema.properties : {}
      const keys = Object.keys(properties)
      const initial = config.phase === 'ready' ? initialOf(config.effective, config.schema) : {}
      const editable = keys.filter(key => isEditable(properties[key]))
      const changed = editable.filter(key => !sameValue(draft[key], initial[key]))

      const save = async () => {
        if (saving || config.phase !== 'ready') return
        const values = {}
        for (const key of changed) {
          const property = properties[key] ?? {}
          const value = typedValue(property, draft[key])
          if (value === null) {
            setNotice({ tone: 'error', text: `${key}: ${t('config.number')}` })
            return
          }
          values[key] = value
        }
        if (Object.keys(values).length === 0) {
          setNotice({ tone: 'warning', text: t('config.noChanges') })
          return
        }
        setSaving(true)
        setNotice(null)
        try {
          const answer = await submitPath(CONFIG_URI, {
            intent: SAVE_INTENT,
            expectedRevision: config.revision,
            values,
          }, sessionId)
          if (isConflict(answer)) {
            setConflict(typeof answer?.error === 'string' ? answer.error : t('config.conflict'))
            return
          }
          if (typeof answer !== 'object' || answer === null || answer.ok !== true
            || !Number.isFinite(answer.revision)) {
            throw new Error(typeof answer?.error === 'string' ? answer.error : 'unexpected save answer')
          }
          const effective = answer.effective && typeof answer.effective === 'object' ? answer.effective : config.effective
          setConfig({
            phase: 'ready', schema: config.schema, effective, revision: answer.revision,
            project: config.project, values: answer.values ?? { ...config.values, ...values },
          })
          setDraft(initialOf(effective, config.schema))
          setConflict(null)
          setNotice({ tone: 'success', text: t('config.saved') })
        } catch (error) {
          if (/revision|conflict|stale/i.test(messageOf(error))) {
            setConflict(messageOf(error))
            return
          }
          setNotice({ tone: 'error', text: messageOf(error) })
        } finally {
          if (mounted.current) setSaving(false)
        }
      }

      const retry = async () => {
        if (retrying) return
        setRetrying(true)
        setNotice(null)
        setRetryResult(null)
        try {
          const answer = await submitPath(QUEUE_URI, {
            intent: RETRY_INTENT,
            action: 'retry',
          }, sessionId)
          setRetryResult(reportOf(answer))
          setQueueReloadKey(value => value + 1)
        } catch (error) {
          setNotice({ tone: 'error', text: `${t('queue.failedRetry')}: ${messageOf(error)}` })
        } finally {
          if (mounted.current) setRetrying(false)
        }
      }

      const refresh = () => {
        setReloadKey(value => value + 1)
        setQueueReloadKey(value => value + 1)
      }

      const configBody = config.phase === 'loading'
        ? h('div', { className: 'omd-hs-loading' }, t('console.loading'))
        : config.phase === 'error'
          ? h('div', { className: 'omd-hs-notice', 'data-tone': 'error', 'data-hs-part': 'config-error' },
            `${t('console.readFailed')}: ${config.error}`,
            ' ', h('button', {
              type: 'button', className: 'omd-hs-btn',
              onClick: () => setReloadKey(value => value + 1),
            }, t('console.retryRead')))
          : h('div', { className: 'omd-hs-form', 'data-hs-part': 'config-form' },
            h('div', { className: 'omd-hs-section-hint' }, t('config.hint')),
            keys.length === 0
              ? h('div', { className: 'omd-hs-empty' }, t('config.noFields'))
              : keys.map(key => {
                const property = properties[key] ?? {}
                const title = typeof property.title === 'string' ? property.title : key
                if (!isEditable(property)) {
                  const effectiveValue = config.effective !== null && typeof config.effective === 'object'
                    ? config.effective[key] : undefined
                  return h('div', {
                    key, className: 'omd-hs-field', 'data-hs-part': 'field', 'data-key': key, 'data-readonly': 'true',
                  },
                  h('span', { className: 'omd-hs-field-head' },
                    h('span', { className: 'omd-hs-field-title' }, title),
                    h('code', { className: 'omd-hs-field-key' }, key)),
                  h('pre', { className: 'omd-hs-field-value' },
                    JSON.stringify(effectiveValue ?? null, null, 2)))
                }
                const overridden = config.values && typeof config.values === 'object'
                  && Object.prototype.hasOwnProperty.call(config.values, key)
                const options = Array.isArray(property.enum) ? property.enum : null
                const value = draft[key]
                let control
                if (options !== null) {
                  control = h('select', {
                    className: 'omd-hs-select omd-hs-input', 'data-hs-part': 'field-input',
                    value: value ?? '',
                    onChange: event => setDraft(previous => ({ ...previous, [key]: event.target.value })),
                  },
                  h('option', { value: '' }, t('bar.unknown')),
                  options.map((option, index) => h('option', {
                    key: `${key}-${index}`, value: String(option),
                  }, String(option))))
                } else if (property.type === 'boolean') {
                  control = h('input', {
                    type: 'checkbox', className: 'omd-hs-checkbox', 'data-hs-part': 'field-input',
                    checked: value === true || value === 'true',
                    onChange: event => setDraft(previous => ({ ...previous, [key]: event.target.checked })),
                  })
                } else {
                  control = h('input', {
                    className: 'omd-hs-input', 'data-hs-part': 'field-input',
                    type: property.type === 'number' || property.type === 'integer' ? 'number' : 'text',
                    value: value ?? '',
                    ...(Number.isFinite(property.minimum) ? { min: property.minimum } : {}),
                    ...(Number.isFinite(property.maximum) ? { max: property.maximum } : {}),
                    ...(property.type === 'integer' ? { step: 1 } : {}),
                    onChange: event => setDraft(previous => ({ ...previous, [key]: event.target.value })),
                  })
                }
                return h('label', {
                  key, className: 'omd-hs-field', 'data-hs-part': 'field', 'data-key': key,
                },
                h('span', { className: 'omd-hs-field-head' },
                  h('span', { className: 'omd-hs-field-title' }, title),
                  h('code', { className: 'omd-hs-field-key' }, key),
                  overridden ? h('span', { className: 'omd-hs-field-override' }, t('config.override')) : null),
                typeof property.description === 'string'
                  ? h('span', { className: 'omd-hs-field-desc' }, property.description) : null,
                control)
              }),
            h('div', { className: 'omd-hs-form-actions' },
              h('button', {
                type: 'button', className: 'omd-hs-btn omd-hs-save',
                'data-hs-part': 'save', 'data-primary': 'true',
                disabled: saving || changed.length === 0, onClick: () => void save(),
              }, saving ? t('config.saving') : t('config.save'))))

      const snapshot = queue.phase === 'ready' ? queue.snapshot : null
      const rows = [
        ...(snapshot?.pending ?? []).map(entry => ({ entry, section: 'pending' })),
        ...(snapshot?.failed ?? []).map(entry => ({ entry, section: 'failed' })),
      ]
      const corrupt = snapshot && Array.isArray(snapshot.corrupt) ? snapshot.corrupt : []
      const queueBody = queue.phase === 'loading'
        ? h('div', { className: 'omd-hs-loading' }, t('console.loading'))
        : queue.phase === 'error'
          ? h('div', { className: 'omd-hs-notice', 'data-tone': 'error', 'data-hs-part': 'queue-error' },
            `${t('console.readFailed')}: ${queue.error}`,
            ' ', h('button', {
              type: 'button', className: 'omd-hs-btn',
              onClick: () => setQueueReloadKey(value => value + 1),
            }, t('console.retryRead')))
          : h('div', { className: 'omd-hs-queue-list', 'data-hs-part': 'queue-list' },
            rows.length === 0 && corrupt.length === 0
              ? h('div', { className: 'omd-hs-empty' }, t('queue.empty'))
              : h('div', { className: 'omd-hs-queue-rows' },
                rows.map(({ entry, section }) => queueRow(entry, section, sessionId, t)),
                corrupt.length > 0
                  ? h('div', { key: 'corrupt', className: 'omd-hs-subhead' }, t('queue.corrupt')) : null,
                corrupt.map((name, index) => h('div', {
                  key: `corrupt-${index}`,
                  className: 'omd-hs-queue-row', 'data-hs-part': 'queue-row', 'data-state': 'corrupt',
                }, h('code', { className: 'omd-hs-queue-chip' }, String(name))))))

      return h(React.Fragment, null,
        h('div', {
          className: 'omd-hs-console-backdrop', 'data-hs-part': 'backdrop', onClick: onClose,
        }),
        h('div', {
          className: 'omd-hs-console', 'data-hs-part': 'console',
          role: 'dialog', 'aria-modal': 'true', 'aria-label': t('console.title'),
        },
        h('div', { className: 'omd-hs-console-head' },
          h('span', { className: 'omd-hs-console-title' }, t('console.title')),
          h('span', { className: 'omd-hs-console-meta' },
            config.phase === 'ready'
              ? `${t('console.project')}: ${String(config.project ?? t('bar.unknown'))} · ${t('console.revision')} ${config.revision}`
              : ''),
          h('span', { className: 'omd-hs-head-actions' },
            h('button', {
              type: 'button', className: 'omd-hs-btn', 'data-hs-part': 'refresh', onClick: refresh,
            }, t('console.refresh')),
            h('button', {
              type: 'button', className: 'omd-hs-btn omd-hs-close',
              'data-hs-part': 'close', 'aria-label': t('console.close'), onClick: onClose,
            }, '✕'))),
        h('div', { className: 'omd-hs-tabs', 'data-hs-part': 'tabs', role: 'tablist' },
          ['config', 'queue'].map(id => h('button', {
            key: id, type: 'button', className: 'omd-hs-tab', role: 'tab',
            'data-hs-part': 'tab', 'data-tab': id, 'data-active': tab === id ? 'true' : 'false',
            'aria-selected': tab === id ? 'true' : 'false',
            onClick: () => setTab(id),
          }, t(`console.tab.${id}`)))),
        h('div', { className: 'omd-hs-console-body' },
          typeof statusProblem === 'string' && statusProblem !== ''
            ? h('div', {
              className: 'omd-hs-notice', 'data-tone': 'warning', 'data-hs-part': 'status-error',
            }, `${t('console.statusNote')}: ${statusProblem}`)
            : null,
          conflict !== null
            ? h('div', { className: 'omd-hs-conflict', 'data-hs-part': 'conflict', 'data-tone': 'warning' },
              h('span', { className: 'omd-hs-conflict-text' }, `${t('config.conflict')} ${conflict}`),
              h('button', {
                type: 'button', className: 'omd-hs-btn', 'data-hs-part': 'conflict-reload',
                onClick: () => { keepDraft.current = true; setReloadKey(value => value + 1) },
              }, t('config.reload')))
            : null,
          notice !== null
            ? h('div', {
              className: 'omd-hs-notice', 'data-hs-part': 'notice', 'data-tone': notice.tone,
            }, notice.text)
            : null,
          tab === 'config' ? configBody : null,
          tab === 'queue'
            ? h('div', null,
              h('div', { className: 'omd-hs-queue-head' },
                h('button', {
                  type: 'button', className: 'omd-hs-btn omd-hs-retry',
                  'data-hs-part': 'retry', 'data-primary': 'true',
                  disabled: retrying || queue.phase !== 'ready', onClick: () => void retry(),
                }, retrying ? t('queue.retrying') : t('queue.retry')),
                retryResult !== null
                  ? h('span', {
                    className: 'omd-hs-queue-chip', 'data-hs-part': 'retry-result',
                  }, t('queue.result', retryResult))
                  : null),
              queueBody)
            : null)))
    }

    /** One queued retry row, with its own read-only internal address. */
    function queueRow(entry, section, sessionId, t) {
      const row = typeof entry === 'object' && entry !== null ? entry : {}
      const path = typeof row.id === 'string' && row.id !== '' ? queueEntryPath(row) : QUEUE_URI
      return h('div', {
        key: `${section}-${String(row.id ?? '')}`,
        className: 'omd-hs-queue-row', 'data-hs-part': 'queue-row',
        'data-state': section, 'data-entry': String(row.id ?? ''),
      },
      h('div', { className: 'omd-hs-queue-row-head' },
        h('span', { className: 'omd-hs-queue-bank' }, String(row.bank ?? t('bar.unknown'))),
        h('span', { className: 'omd-hs-queue-chip' }, String(row.state ?? section)),
        h('span', { className: 'omd-hs-queue-chip' },
          `${String(row.attempts ?? 0)} ${t('queue.attempts')}`),
        typeof row.createdAt === 'string'
          ? h('span', { className: 'omd-hs-queue-chip' }, row.createdAt) : null,
        h('code', { className: 'omd-hs-queue-chip' }, String(row.id ?? ''))),
      typeof row.lastError === 'string' && row.lastError !== ''
        ? h('div', { className: 'omd-hs-queue-error' },
          `${t('queue.lastError')}: ${row.lastError}`) : null,
      h('button', {
        type: 'button', className: 'omd-hs-link', 'data-hs-part': 'queue-evidence',
        title: t('queue.evidence'), onClick: () => openEvidence(path, sessionId, t),
      }, path))
    }

    // ------------------------------------------------------------------
    // Read-only evidence preview.
    //
    // A portaled overlay is mounted by a tiny React root of its own so every
    // caller (queue rows and recall cards alike) can open a resource without
    // owning a modal state tree. The root is unmounted on close.
    // ------------------------------------------------------------------

    function openEvidence(uri, sessionId, t) {
      const host = document.createElement('div')
      document.body.append(host)
      const root = ReactDOMClient.createRoot(host)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        queueMicrotask(() => root.unmount())
        host.remove()
      }
      root.render(h(EvidencePreview, { uri, sessionId, t, onClose: close }))
    }

    function EvidencePreview({ uri, sessionId, t, onClose }) {
      const [state, setState] = React.useState({ phase: 'loading' })
      React.useEffect(() => {
        const current = new AbortController()
        let live = true
        readPath(uri, sessionId, current.signal)
          .then(body => {
            if (!live) return
            const text = typeof body === 'string' ? body
              : body !== undefined ? JSON.stringify(body, null, 2) : ''
            setState({ phase: 'ready', text })
          })
          .catch(error => {
            if (live && !current.signal.aborted) setState({ phase: 'error', error: messageOf(error) })
          })
        return () => { live = false; current.abort() }
      }, [uri, sessionId])
      React.useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      const plain = h('pre', null, state.text ?? '')
      return h(React.Fragment, null,
        h('div', { className: 'omd-hs-preview-backdrop', onClick: onClose }),
        h('div', {
          className: 'omd-hs-preview', 'data-hs-part': 'preview',
          role: 'dialog', 'aria-modal': 'true', 'aria-label': t('preview.title'),
        },
        h('div', { className: 'omd-hs-preview-head' },
          h('span', { className: 'omd-hs-preview-title' }, t('preview.title')),
          h('span', { className: 'omd-hs-preview-uri', 'data-hs-part': 'preview-uri' }, uri),
          h('button', {
            type: 'button', className: 'omd-hs-btn omd-hs-preview-close',
            'data-hs-part': 'preview-close', onClick: onClose,
          }, t('preview.close'))),
        h('div', { className: 'omd-hs-preview-body', 'data-hs-part': 'preview-body' },
          state.phase === 'loading' ? h('div', { className: 'omd-hs-loading' }, t('preview.loading')) : null,
          state.phase === 'error'
            ? h('div', { className: 'omd-hs-preview-error' },
              `${t('preview.failed')}: ${state.error}`) : null,
          state.phase === 'ready'
            ? (/^\s*[{[]/.test(state.text) ? plain : h(MarkdownText, { text: state.text, variant: 'compact' }))
            : null)))
    }

    // ------------------------------------------------------------------
    // Injected recall card.
    // ------------------------------------------------------------------

    function textOf(value) {
      return typeof value === 'string' ? value : ''
    }

    function normalizeFact(fact) {
      if (typeof fact !== 'object' || fact === null) return null
      const text = textOf(fact.text)
      if (text === '') return null
      return {
        bank: textOf(fact.bank),
        id: textOf(fact.id),
        text,
        type: typeof fact.type === 'string' ? fact.type : null,
        path: textOf(fact.path),
        chunkPath: typeof fact.chunkPath === 'string' ? fact.chunkPath : null,
        antiPattern: fact.antiPattern === true,
      }
    }

    function normalizeRecall(details, seq) {
      const source = typeof details === 'object' && details !== null ? details : {}
      return {
        seq,
        query: textOf(source.query),
        fence: textOf(source.fence) || 'hindsight_memories',
        banks: Array.isArray(source.banks) ? source.banks.filter(name => typeof name === 'string') : [],
        facts: Array.isArray(source.facts) ? source.facts.map(normalizeFact).filter(fact => fact !== null) : [],
      }
    }

    function isRecall(event) {
      if (event.type !== 'user/message') return false
      if (typeof event.surfaceOp === 'object' && event.surfaceOp !== null) return false
      const data = event.data
      if (typeof data !== 'object' || data === null) return false
      const source = data.source
      return typeof source === 'object' && source !== null
        && source.kind === 'hindsight' && source.form === 'recall'
        && typeof source.details === 'object' && source.details !== null
    }

    function matchRecall(event) {
      if (!isRecall(event)) return null
      const id = typeof event.data.id === 'string' && event.data.id !== ''
        ? event.data.id : `hindsight:${event.seq}`
      return { id, role: 'start' }
    }

    function startRecall(_context, matched) {
      return normalizeRecall(matched.event.data.source.details, matched.event.seq)
    }

    function locationOf(context) {
      return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
    }

    function evidenceOf(fact) {
      return fact.chunkPath || fact.path || ''
    }

    function RecallCard(props) {
      const { node, t } = props
      const sessionId = sessionIdOf(props)
      const card = node.data ?? {}
      const banks = Array.isArray(card.banks) ? card.banks : []
      const facts = Array.isArray(card.facts) ? card.facts : []
      return h('div', {
        className: 'omd-hs-card', 'data-hs-part': 'card', 'data-kind': CARD_KIND,
        role: 'note', 'aria-label': CARD_HEADER,
      },
      h('div', { className: 'omd-hs-card-head' },
        h('span', { className: 'omd-hs-card-mark', 'aria-hidden': 'true' }, '◈'),
        h('span', { className: 'omd-hs-card-title', 'data-hs-part': 'card-header' }, CARD_HEADER),
        h('span', { className: 'omd-hs-card-banks', 'data-hs-part': 'card-banks' },
          `${t('card.banks')}: `,
          banks.length === 0
            ? t('bar.unknown')
            : banks.map((name, index) => h('code', {
              key: `${name}-${index}`, className: 'omd-hs-bank-chip',
            }, name)))),
      h('ul', { className: 'omd-hs-card-facts', 'data-hs-part': 'facts' },
        facts.map((fact, index) => {
          const path = evidenceOf(fact)
          return h('li', {
            key: `${fact.bank}/${fact.id}/${index}`,
            className: 'omd-hs-fact', 'data-hs-part': 'fact',
            'data-anti': fact.antiPattern ? 'true' : 'false',
          },
          h('div', { className: 'omd-hs-fact-head' },
            h('span', { className: 'omd-hs-fact-type' },
              fact.antiPattern ? `⚠ ${t('card.antiPattern')}` : (fact.type ?? t('card.unknownType'))),
            h('span', { className: 'omd-hs-fact-text', 'data-hs-part': 'fact-text', title: fact.text },
              fact.text.replace(/\s+/g, ' ').trim())),
          path !== ''
            ? h('button', {
              type: 'button', className: 'omd-hs-link omd-hs-evidence',
              'data-hs-part': 'evidence', title: path,
              onClick: () => openEvidence(path, sessionId, t),
            }, path)
            : null)
        })),
      h('div', { className: 'omd-hs-card-foot' },
        typeof card.query === 'string' && card.query !== ''
          ? h('span', { 'data-hs-part': 'card-query' }, `${t('card.query')}: ${card.query}`) : null,
        h('span', null, `${t('card.fence')}: ${card.fence ?? ''}`)))
    }

    // ------------------------------------------------------------------
    // Registration.
    // ------------------------------------------------------------------

    let pluginCtx

    function apply(ctx) {
      pluginCtx = ctx
      ctx.effect(installStyles, 'omd-hindsight: stylesheet')
      ctx.effect(() => ctx.locale?.register?.(NS, { en, zh }), 'omd-hindsight: dictionaries')

      ctx.effect(() => ctx.uiConversation.events.register({
        kind: CARD_KIND,
        target: 'chat',
        match: matchRecall,
        start: startRecall,
        update: (_context, match) => normalizeRecall(match.event.data.source.details, match.event.seq),
        publication: () => 'immediate',
        buildViewNode(context) {
          const card = context.state
          if (card === null || typeof card !== 'object') return null
          if (typeof card.seq !== 'number' || !Number.isFinite(card.seq)) return null
          return {
            key: context.key,
            id: context.id,
            kind: CARD_KIND,
            target: 'chat',
            anchorSeq: card.seq,
            location: locationOf(context),
            visibility: 'visible',
            data: card,
          }
        },
      }), 'omd-hindsight: recall card definition')

      ctx.effect(() => ctx.slots.inject(CHAT_SLOT, () => ctx.slots.register({
        name: CHAT_SLOT, key: CARD_KIND, locale: NS,
      }, RecallCard)), 'omd-hindsight: recall card renderer')

      ctx.effect(() => ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
        name: DOCK_SLOT, id: 'omd-hindsight-status', order: 6,
      }, HindsightStrip)), 'omd-hindsight: status strip')
    }

    exports.inject = ['slots', 'locale', 'uiConversation']
    exports.apply = apply
    return module.exports
  },
})
