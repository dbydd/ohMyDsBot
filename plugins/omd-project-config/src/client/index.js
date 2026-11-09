// Browser half of omd-project-config. Hand-authored because the web shell
// serves this file to the page as-is: a build step would need a bundler the
// plugin runtime does not require, so the module-loader factory is written
// directly. Only platform modules (react and the shared primitives) are
// requested from the module table.
window.__ModuleLoader__.load({
  id: 'omd-project-config',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const ReactDOM = require('react-dom')
    const {
      IconSlidersTwoOutlineRegular, Input, Modal, Switch,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const NS = 'omd.projectConfig'
    /** Foot of DS-Bot's own left column; see `watchFoot`. */
    const DSBOT_FOOT = '.bt-leftcol-foot'

    const en = {
      footer: 'Project settings',
      'footer.disabled': 'Open a project workspace to edit its settings',
      command: 'Project settings',
      'command.description': 'Edit parameters for the current workspace',
      title: 'Project settings',
      close: 'Close',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      clearAll: 'Clear personal override',
      clearField: 'Clear',
      loading: 'Loading…',
      noWorkspace: 'No project workspace is selected. Open a workspace first.',
      'bank.placeholder': 'Derive from the project path',
      'group.memory': 'Memory',
      'group.delegation': 'Delegation',
      'group.roles': 'Roles',
      'source.default': 'Default',
      'source.repo': 'From repository file',
      'source.user': 'From personal override',
      'field.memory.enabled': 'Enable memory',
      'field.memory.enabled.description': 'Whether this project uses the memory backend at all.',
      'field.memory.bank': 'Memory bank',
      'field.memory.bank.description': 'Bank this project writes to and recalls from; empty derives it from the project path.',
      'field.memory.recallTokens': 'Recall token cap',
      'field.memory.recallTokens.description': 'Maximum tokens one memory injection may add.',
      'field.delegation.maxActive': 'Concurrent subagents',
      'field.delegation.maxActive.description': 'How many subagents our dispatcher may run at once for this project.',
      'field.roles.overrides': 'Role routes',
      'field.roles.overrides.description': 'JSON object mapping a role name to { provider, model }.',
      'error.save': 'The settings could not be saved.',
      'error.number': 'Enter a positive whole number.',
      'error.json': 'Role routes must be valid JSON.',
    }

    const zh = {
      footer: '项目设置',
      'footer.disabled': '打开一个项目工作区后才能编辑它的设置',
      command: '项目设置',
      'command.description': '编辑当前工作区的项目参数',
      title: '项目设置',
      close: '关闭',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      clearAll: '清除个人覆盖',
      clearField: '清除',
      loading: '加载中…',
      noWorkspace: '没有选中的项目工作区。请先打开一个工作区。',
      'bank.placeholder': '按项目路径派生',
      'group.memory': '记忆',
      'group.delegation': '委派',
      'group.roles': '角色',
      'source.default': '默认值',
      'source.repo': '来自仓库文件',
      'source.user': '来自个人覆盖',
      'field.memory.enabled': '启用记忆',
      'field.memory.enabled.description': '该项目是否使用记忆后端。',
      'field.memory.bank': '记忆 bank',
      'field.memory.bank.description': '该项目写入与召回使用的 bank；留空表示按项目路径派生。',
      'field.memory.recallTokens': '召回 token 上限',
      'field.memory.recallTokens.description': '单次记忆注入最多可加入的 token 数。',
      'field.delegation.maxActive': '并发子代理数',
      'field.delegation.maxActive.description': '我们的派发器在该项目下允许同时运行的子代理数。',
      'field.roles.overrides': '角色路由',
      'field.roles.overrides.description': 'JSON 对象，角色名映射到 { provider, model }。',
      'error.save': '设置未能保存。',
      'error.number': '请输入正整数。',
      'error.json': '角色路由必须是合法 JSON。',
    }

    const STYLE_ID = 'omd-project-config-styles'
    const CSS = `
.omd-pc-footer {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 8px; background: transparent;
  color: inherit; font: inherit; cursor: pointer; text-align: left;
}
.omd-pc-footer:hover:not([disabled]) { background: color-mix(in oklab, currentColor 8%, transparent); }
.omd-pc-footer[disabled] { opacity: .5; cursor: default; }
.omd-pc-footer-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omd-pc-dialog { width: min(560px, 100%); }
.omd-pc-body { display: flex; flex-direction: column; gap: 18px; max-height: min(62vh, 640px); overflow-y: auto; padding: 0 24px; }
.omd-pc-head { display: flex; flex-direction: column; gap: 2px; }
.omd-pc-title { font-size: 14px; font-weight: 600; }
.omd-pc-path { font-size: 12px; opacity: .65; word-break: break-all; }
.omd-pc-group { display: flex; flex-direction: column; gap: 8px; }
.omd-pc-group-title { font-size: 12px; font-weight: 600; opacity: .6; text-transform: uppercase; letter-spacing: .04em; }
.omd-pc-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid color-mix(in oklab, currentColor 10%, transparent); }
.omd-pc-row:last-child { border-bottom: 0; }
.omd-pc-label { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.omd-pc-desc { font-size: 11px; opacity: .6; }
.omd-pc-control { display: flex; align-items: center; gap: 8px; }
.omd-pc-control input[type="number"] { width: 96px; }
.omd-pc-textarea { box-sizing: border-box; width: 100%; min-height: 96px; resize: vertical; padding: 8px; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 18%, transparent); background: transparent; color: inherit; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.omd-pc-wide { grid-column: 1 / -1; }
.omd-pc-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; opacity: .7; }
.omd-pc-source[data-source="user"] { font-weight: 600; opacity: 1; }
.omd-pc-link { border: 0; background: transparent; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; padding: 0; opacity: .8; }
.omd-pc-error { font-size: 12px; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); background: color-mix(in oklab, currentColor 8%, transparent); white-space: pre-wrap; word-break: break-word; }
.omd-pc-footer-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 24px; }
.omd-pc-actions { display: flex; gap: 8px; }
.omd-pc-button { padding: 6px 14px; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 20%, transparent); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.omd-pc-button[data-primary="true"] { background: color-mix(in oklab, currentColor 12%, transparent); font-weight: 600; }
.omd-pc-button[disabled] { opacity: .5; cursor: default; }
.omd-pc-dsbot-seat { display: contents; }
.omd-pc-dsbot-action {
  flex: 1 1 auto; min-width: 0; overflow: hidden; display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border: 0; border-radius: 8px; background: transparent;
  color: inherit; font: inherit; font-size: 13px; line-height: 18px;
  cursor: pointer; text-align: left;
}
.omd-pc-dsbot-action:hover:not([disabled]) { background: var(--bt-hover, color-mix(in oklab, currentColor 8%, transparent)); }
.omd-pc-dsbot-action[disabled] { opacity: .5; cursor: default; }
.omd-pc-dsbot-action:focus-visible { outline: 2px solid var(--bt-accent, currentColor); outline-offset: 1px; }
.omd-pc-dsbot-action > svg { flex: none; }
.bt-leftcol[data-left=rail] .omd-pc-dsbot-action {
  flex: none; width: 36px; height: 36px; padding: 0; justify-content: center;
  border: 1px solid var(--bt-line, color-mix(in oklab, currentColor 15%, transparent));
  border-radius: 50%; background: var(--bt-main, transparent);
}
.bt-leftcol[data-left=rail] .omd-pc-dsbot-action .omd-pc-footer-label { display: none; }
`

    function injectStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function strictCodec() {
      return {
        mode: 'strict',
        typeSymbol: 'omd.projectConfig.any',
        create: () => ({ parse: value => value }),
      }
    }

    function descriptor(method, parameters) {
      return {
        id: `omd-project-config#${method}`,
        service: 'projectConfig',
        namespace: 'projectConfig',
        method,
        invocation: { kind: 'direct' },
        parameters: parameters.map(parameter => ({
          name: parameter.name,
          wire: parameter.name,
          source: 'json',
          codec: strictCodec(),
          ...parameter.optional === true ? { acceptsUndefined: true } : {},
        })),
        result: { mode: 'src-json' },
      }
    }

    const CONTRIBUTION = {
      package: 'omd-project-config',
      descriptors: [
        descriptor('schema', []),
        descriptor('resolve', [{ name: 'cwd' }]),
        descriptor('list', []),
        descriptor('layers', [{ name: 'root' }]),
        descriptor('write', [{ name: 'root' }, { name: 'patch' }]),
        descriptor('clear', [{ name: 'root' }, { name: 'path', optional: true }]),
      ],
    }

    function createRemote(ctx) {
      let mounting
      const namespace = async () => {
        const existing = ctx.get('remote.projectConfig')
        if (existing !== undefined) return existing
        const remote = ctx.get('remote')
        if (remote === undefined) throw new Error('the client Remote service is unavailable')
        mounting ??= remote.$mount(CONTRIBUTION).catch(error => {
          mounting = undefined
          throw error
        })
        await mounting
        return ctx.get('remote.projectConfig')
      }
      return {
        mount: namespace,
        async call(method, args) {
          const ns = await namespace()
          if (ns === undefined) throw new Error('the projectConfig Remote namespace is unavailable')
          const result = await ns[method](...args)
          if (!result.ok) throw new Error(result.error?.message ?? `${method} failed`)
          return result.value
        },
      }
    }

    function createPanelStore() {
      let state = { open: false, cwd: undefined, title: '', missingWorkspace: false }
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        open(next) {
          state = { open: true, missingWorkspace: false, title: '', ...next }
          for (const listener of listeners) listener()
        },
        close() {
          state = { ...state, open: false }
          for (const listener of listeners) listener()
        },
      }
    }

    /**
     * The foot element of DS-Bot's own left column, or null when that column is
     * not on screen.
     *
     * DS-Bot portals the column over the shell's collapsed sidebar, so it
     * covers the seat our button normally takes. This one element is the whole
     * state: it gates the shell seat and targets the portal, which keeps exactly
     * one entry on screen and puts it where the pointer can reach it.
     */
    function createFootStore() {
      let foot = null
      const listeners = new Set()
      return {
        getSnapshot: () => foot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          if (foot === next) return
          foot = next
          for (const listener of listeners) listener()
        },
      }
    }

    /**
     * Follow DS-Bot's foot element.
     *
     * DS-Bot installs its column after this plugin mounts and rebuilds the
     * element as the surface changes, so the document is scanned on mutations.
     * The scan is throttled to one task: a streaming turn mutates the
     * transcript continuously, while only this element's identity matters.
     */
    function watchFoot(store) {
      let timer = 0
      const scan = () => {
        timer = 0
        store.set(document.querySelector(DSBOT_FOOT))
      }
      const queue = () => { if (timer === 0) timer = window.setTimeout(scan, 0) }
      const observer = new MutationObserver(queue)
      observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
      scan()
      return () => {
        observer.disconnect()
        if (timer !== 0) window.clearTimeout(timer)
      }
    }

    function currentWorkspace(ctx) {
      const sessions = ctx.get('sessions')?.list.getSnapshot()
      const workspaces = ctx.get('workspaces')?.list.getSnapshot()
      if (sessions === undefined || workspaces === undefined) return undefined
      let current
      for (const id of sessions.ids) {
        const row = sessions.byId[id]
        if ((row.retainedBy?.mainView ?? 0) > 0) {
          current = row
          break
        }
      }
      if (current === undefined) return undefined
      return workspaces.items.find(item => item.sessionIds.includes(current.id))
    }

    function groupOf(path) {
      return path.split('.')[0]
    }

    function buildDraft(schema, fields) {
      const draft = {}
      for (const spec of schema) {
        const value = fields[spec.path].value
        if (spec.kind === 'boolean') draft[spec.path] = value === true
        else if (spec.kind === 'number') draft[spec.path] = String(value)
        else if (spec.kind === 'string-or-null') draft[spec.path] = value ?? ''
        else draft[spec.path] = JSON.stringify(value ?? {}, null, 2)
      }
      return draft
    }

    function setNested(patch, path, value) {
      const [section, key] = path.split('.')
      patch[section] ??= {}
      patch[section][key] = value
    }

    function buildPatch(schema, fields, draft, t) {
      const patch = {}
      for (const spec of schema) {
        const original = fields[spec.path].value
        let value
        if (spec.kind === 'boolean') {
          value = draft[spec.path] === true
        } else if (spec.kind === 'number') {
          value = Number(draft[spec.path])
          if (!Number.isSafeInteger(value) || value < 1) throw new Error(t('error.number'))
        } else if (spec.kind === 'string-or-null') {
          value = draft[spec.path].trim() === '' ? null : draft[spec.path].trim()
        } else {
          try {
            value = JSON.parse(draft[spec.path])
          } catch (error) {
            throw new Error(`${t('error.json')} ${error instanceof Error ? error.message : String(error)}`)
          }
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error(t('error.json'))
          }
        }
        if (JSON.stringify(value) !== JSON.stringify(original)) setNested(patch, spec.path, value)
      }
      return patch
    }

    function FieldControl({ spec, draft, setDraft, t }) {
      const id = `omd-pc-${spec.path}`
      if (spec.kind === 'boolean') {
        return h(Switch, {
          label: t(`field.${spec.path}`),
          checked: draft[spec.path] === true,
          onChange: next => setDraft(spec.path, next),
        })
      }
      if (spec.kind === 'number') {
        return h(Input, {
          id,
          type: 'number',
          min: 1,
          step: 1,
          value: draft[spec.path],
          onChange: event => setDraft(spec.path, event.target.value),
        })
      }
      if (spec.kind === 'string-or-null') {
        return h(Input, {
          id,
          value: draft[spec.path],
          placeholder: t('bank.placeholder'),
          onChange: event => setDraft(spec.path, event.target.value),
        })
      }
      return h('textarea', {
        id,
        className: 'omd-pc-textarea',
        spellCheck: false,
        value: draft[spec.path],
        onChange: event => setDraft(spec.path, event.target.value),
      })
    }

    function ProjectConfigPanel({ panel, remote, t }) {
      const snapshot = React.useSyncExternalStore(panel.subscribe, panel.getSnapshot)
      const [state, setState] = React.useState({ status: 'idle' })
      const [schema, setSchema] = React.useState([])
      const [fields, setFields] = React.useState(undefined)
      const [draft, setDraft] = React.useState({})
      const [root, setRoot] = React.useState('')
      const [projectTitle, setProjectTitle] = React.useState('')
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [saved, setSaved] = React.useState(false)

      const load = React.useCallback(async () => {
        if (snapshot.cwd === undefined) {
          setState({ status: 'missing' })
          setFields(undefined)
          return
        }
        setState({ status: 'loading' })
        setError(null)
        try {
          const [rows, resolved] = await Promise.all([
            remote.call('schema', []),
            remote.call('resolve', [snapshot.cwd]),
          ])
          setSchema(rows)
          setFields(resolved.fields)
          setDraft(buildDraft(rows, resolved.fields))
          setRoot(resolved.root)
          setProjectTitle(resolved.title)
          setState({ status: 'ready' })
        } catch (failure) {
          setState({ status: 'error' })
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [snapshot.cwd])

      React.useEffect(() => {
        if (!snapshot.open) return
        setSaved(false)
        void load()
      }, [snapshot.open, snapshot.cwd])

      const setDraftValue = (path, value) => {
        setSaved(false)
        setDraft(current => ({ ...current, [path]: value }))
      }

      const save = async () => {
        if (fields === undefined) return
        setBusy(true)
        setError(null)
        try {
          const patch = buildPatch(schema, fields, draft, t)
          if (Object.keys(patch).length > 0) {
            const resolved = await remote.call('write', [root, patch])
            setFields(resolved.fields)
            setDraft(buildDraft(schema, resolved.fields))
          }
          setSaved(true)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const clear = async path => {
        setBusy(true)
        setError(null)
        try {
          const resolved = await remote.call('clear', path === undefined ? [root] : [root, path])
          setFields(resolved.fields)
          setDraft(buildDraft(schema, resolved.fields))
          setSaved(true)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const hasUserLayer = fields !== undefined && Object.values(fields).some(field => field.source === 'user')
      const rows = schema
        .map(spec => h('div', { className: 'omd-pc-row', key: spec.path }, [
          h('div', { className: 'omd-pc-wide', key: 'label' },
            h(spec.kind === 'boolean' ? 'div' : 'label', {
              className: 'omd-pc-label',
              ...spec.kind === 'boolean' ? {} : { htmlFor: `omd-pc-${spec.path}` },
            },
              h('span', null, t(`field.${spec.path}`)),
              h('span', { className: 'omd-pc-desc' }, t(`field.${spec.path}.description`)))),
          h('div', { className: spec.kind === 'role-routes' ? 'omd-pc-control omd-pc-wide' : 'omd-pc-control', key: 'control' },
            h(FieldControl, { spec, draft, setDraft: setDraftValue, t })),
          fields === undefined ? null : h('div', { className: 'omd-pc-meta', key: 'meta' },
            h('span', { className: 'omd-pc-source', key: 'source', 'data-source': fields[spec.path].source },
              t(`source.${fields[spec.path].source}`)),
            fields[spec.path].source === 'user'
              ? h('button', {
                type: 'button',
                key: 'clear',
                className: 'omd-pc-link',
                disabled: busy,
                onClick: () => { void clear(spec.path) },
              }, t('clearField'))
              : null),
        ]))

      const grouped = []
      const groups = []
      for (const spec of schema) {
        const group = groupOf(spec.path)
        if (!groups.includes(group)) groups.push(group)
      }
      for (const group of groups) {
        const groupRows = schema
          .map((spec, index) => ({ spec, index }))
          .filter(entry => groupOf(entry.spec.path) === group)
        if (groupRows.length === 0) continue
        grouped.push(h('section', { className: 'omd-pc-group', key: group },
          h('div', { className: 'omd-pc-group-title' }, t(`group.${group}`)),
          groupRows.map(entry => rows[entry.index])))
      }

      return h(Modal, {
        open: snapshot.open,
        onClose: panel.close,
        title: t('title'),
        closeLabel: t('close'),
        className: 'omd-pc-dialog',
        footer: h('div', { className: 'omd-pc-footer-bar' },
          h('button', {
            type: 'button',
            className: 'omd-pc-button',
            disabled: busy || !hasUserLayer,
            onClick: () => { void clear(undefined) },
          }, t('clearAll')),
          h('div', { className: 'omd-pc-actions' },
            h('button', { type: 'button', className: 'omd-pc-button', onClick: panel.close }, t('close')),
            h('button', {
              type: 'button',
              className: 'omd-pc-button',
              'data-primary': 'true',
              disabled: busy || state.status !== 'ready',
              onClick: () => { void save() },
            }, busy ? t('saving') : saved ? t('saved') : t('save'))))
      }, h('div', { className: 'omd-pc-body' }, [
        h('div', { className: 'omd-pc-head', key: 'head' },
          h('div', { className: 'omd-pc-title', key: 'title' }, projectTitle !== '' ? projectTitle : (snapshot.title || t('title'))),
          h('div', { className: 'omd-pc-path', key: 'path' }, root !== '' ? root : (snapshot.cwd ?? ''))),
        state.status === 'missing'
          ? h('div', { className: 'omd-pc-error', key: 'missing' }, t('noWorkspace'))
          : null,
        state.status === 'loading' ? h('div', { className: 'omd-pc-path', key: 'loading' }, t('loading')) : null,
        error !== null ? h('div', { className: 'omd-pc-error', key: 'error' }, error) : null,
        ...grouped,
      ]))
    }

    /** The workspace behind the session the main view shows. */
    function useProjectWorkspace(useSessions, useWorkspaces) {
      const current = useSessions(state => {
        for (const id of state.ids) {
          const row = state.byId[id]
          if ((row.retainedBy?.mainView ?? 0) > 0) return row
        }
        return undefined
      })
      return useWorkspaces(state => current === undefined
        ? undefined
        : state.items.find(item => item.sessionIds.includes(current.id)))
    }

    /**
     * The button both seats draw.
     *
     * `wide` decides only whether the label is in the tree; the DS-Bot seat
     * always passes true and lets CSS drop the label in the rail, so a column
     * resize never has to reach React.
     */
    function ProjectSettingsButton({ cwd, projectTitle, panel, wide, className, t }) {
      const label = t('footer')
      return h('button', {
        type: 'button',
        className,
        disabled: cwd === undefined,
        title: cwd === undefined ? t('footer.disabled') : `${label} — ${cwd}`,
        'aria-label': cwd === undefined ? t('footer.disabled') : label,
        onClick: () => panel.open({ cwd, title: projectTitle }),
      }, [
        h(IconSlidersTwoOutlineRegular, { key: 'icon' }),
        wide ? h('span', { className: 'omd-pc-footer-label', key: 'label' }, label) : null,
      ])
    }

    /** The shell's sidebar seat, for a host without DS-Bot's column. */
    function ProjectConfigFooter({ wide, useSessions, useWorkspaces, panel, footStore, t }) {
      const foot = React.useSyncExternalStore(footStore.subscribe, footStore.getSnapshot)
      const workspace = useProjectWorkspace(useSessions, useWorkspaces)
      // DS-Bot's column covers the shell's foot; the seat there owns the entry.
      if (foot !== null) return null
      return h(ProjectSettingsButton, {
        cwd: workspace?.path,
        projectTitle: workspace?.title ?? '',
        panel, wide, className: 'omd-pc-footer', t,
      })
    }

    /**
     * The same entry inside DS-Bot's own left column.
     *
     * That column is DS-Bot's tree and not ours to edit, so this appends a
     * holder to its foot and portals the button in. The button still renders
     * inside this plugin's tree: same panel store, same Remote namespace, same
     * locale. The holder and the observer both leave with the fiber.
     */
    function ProjectConfigDsBotAction({ useSessions, useWorkspaces, panel, footStore, t }) {
      const foot = React.useSyncExternalStore(footStore.subscribe, footStore.getSnapshot)
      const [holder, setHolder] = React.useState(null)
      React.useEffect(() => {
        if (foot === null) return undefined
        const seat = document.createElement('div')
        seat.className = 'omd-pc-dsbot-seat'
        seat.dataset.omdProjectConfig = ''
        foot.appendChild(seat)
        setHolder(seat)
        return () => {
          seat.remove()
          setHolder(current => (current === seat ? null : current))
        }
      }, [foot])
      const workspace = useProjectWorkspace(useSessions, useWorkspaces)
      if (holder === null) return null
      return ReactDOM.createPortal(h(ProjectSettingsButton, {
        cwd: workspace?.path,
        projectTitle: workspace?.title ?? '',
        panel, wide: true, className: 'omd-pc-dsbot-action', t,
      }), holder)
    }

    function apply(ctx) {
      injectStyles()
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'omd-project-config: dictionaries')
      const t = ctx.locale.bind(NS)
      const panel = createPanelStore()
      const foot = createFootStore()
      const remote = createRemote(ctx)
      ctx.effect(() => watchFoot(foot), 'omd-project-config: DS-Bot left column')

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'omd.project-config',
        locale: NS,
        inject: () => ({ panel, remote }),
      }, ProjectConfigPanel))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'omd.project-config.dsbot',
        locale: NS,
        inject: () => ({ panel, footStore: foot }),
      }, ProjectConfigDsBotAction))

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'omd.project-config',
        order: 100,
        locale: NS,
        inject: () => ({ panel, footStore: foot }),
      }, ProjectConfigFooter))

      ctx.effect(() => ctx.commandUi.register({
        name: 'project-config',
        label: () => t('command'),
        description: () => t('command.description'),
        available: () => currentWorkspace(ctx) !== undefined,
        ui: {
          kind: 'action',
          run: () => {
            const workspace = currentWorkspace(ctx)
            if (workspace === undefined) return
            panel.open({ cwd: workspace.path, title: workspace.title })
          },
        },
      }), 'omd-project-config: /project-config')

      void remote.mount().catch(error => {
        console.error('omd-project-config: mounting the Remote namespace failed', error)
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'remote', 'commandUi']
    return module.exports
  },
})
