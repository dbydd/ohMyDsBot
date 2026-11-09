// Browser half of omd-bot-wizard: step two of Bot creation, as an overlay.
//
// Ownership. Step one — look, name, model — is DS-Bot's own dialog
// (`ds-bot/src/client/create-bot.js`), and it stays exactly that: this module
// never imports it and no upstream file carries a line of ours. What this module
// owns is the seam between that dialog and the host. DS-Bot sends the create with
//
//   POST api/bot   { endpoint: 'create-bot', payload: { name, color, avatar, … } }
//
// and the host's `create-bot` handler already takes `instructions`. So the
// wrapper below holds exactly that one request, asks the two questions DS-Bot has
// no field for, and forwards the same request with the answers folded into
// `instructions`. One round trip, and no post-create `update-bot`: an update after
// the fact would make the host deliver "Your instructions now read: …" into the
// new Bot's chat as an extra message.
//
// Why an overlay rather than a patched dialog: `ds-bot/` is a submodule pinned to
// an upstream tag, so a local edit there is merge debt paid at every upgrade, and
// the host exposes everything this step needs. The package also publishes no
// Hook: `window.dshBot` carries shapes, themes and details tabs only.
//
// Stacking. `shell.overlay` sits in the frame's overlay layer (`z-index: 20`,
// `position: absolute; inset: 0`), while DS-Bot's create pane is
// `position: fixed; z-index: 45`. A slot component would render *underneath* the
// dialog it belongs to, so this module mounts its own root on `document.body` and
// paints above every DS-Bot surface (settings 60, palette 70). The root is removed
// with the fiber, and the fetch wrapper restored with it.
//
// Degradation. A request this module cannot read — a `Request` object, a body
// that is not JSON text, another endpoint — is passed to the original fetch
// untouched. If the wrapper never installs, DS-Bot creates Bots with an empty
// `instructions`, which is what it did before this package existed.

window.__ModuleLoader__.load({
  id: 'omd-bot-wizard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const ReactDOMClient = require('react-dom/client')

    const h = React.createElement
    const NS = 'omd-bot-wizard'
    const STYLE_ID = 'omd-bot-wizard-styles'
    /** The host route DS-Bot's client posts every Bot operation to. */
    const ROUTE = 'api/bot'
    /** The one endpoint this module rewrites. */
    const CREATE = 'create-bot'
    /** Policy a Bot starts on; the safest of the three. */
    const DEFAULT_POLICY = 'on-demand'

    /**
     * The three sandbox policies, in the order the wizard lists them. `value` is
     * what the Bot's instructions record; the label is the human reading of it.
     */
    const POLICIES = [
      { value: 'on-demand', label: '按需拉起', en: 'On demand' },
      { value: 'always', label: '常驻靶机', en: 'Always on' },
      { value: 'none', label: '不分配 VM', en: 'No VM' },
    ]
    const POLICY_VALUES = new Set(POLICIES.map(policy => policy.value))

    const zh = {
      title: '说明与沙箱',
      step: '第 2 步 / 共 2 步',
      named: '为「{name}」补上职责说明与虚拟机策略',
      unnamed: '补上职责说明与虚拟机策略',
      notes: '说明与分工设定',
      notesHint: '写给这个 Bot 看的职责边界：它负责什么、不负责什么、与谁交接。这段话会成为它的 instructions。',
      notesPlaceholder: '例：负责整理每日工单、派活给编码 agent，只在方案定型后才开新工单；不直接改代码。',
      policy: 'Linux 虚拟机沙箱策略',
      policyHint: '宿主还没有 bot 级的沙箱字段，这条策略会写成 instructions 末尾的「沙箱策略：…」一行，宿主以后按这一行读取。',
      'policy.on-demand': '按需拉起',
      'policy.on-demand.why': '有工单时才开一台 Linux 机器，工单结束随机器一起回收。',
      'policy.always': '常驻靶机',
      'policy.always.why': '这个 Bot 一存在就有一台常驻机器，随时可以看桌面、跑命令。',
      'policy.none': '不分配 VM',
      'policy.none.why': '不开机器，这个 Bot 在宿主上工作。',
      create: '创建 Bot',
      cancel: '取消创建',
      cancelled: '已取消创建：没有创建 Bot。',
    }

    const en = {
      title: 'Instructions and sandbox',
      step: 'Step 2 of 2',
      named: 'Add the job description and VM policy for “{name}”',
      unnamed: 'Add the job description and VM policy',
      notes: 'Instructions and division of work',
      notesHint: 'What this Bot owns, what it must not do, and who it hands work to. This text becomes its instructions.',
      notesPlaceholder: 'e.g. Triage the issue queue and dispatch coding agents; open a new issue only once the plan is settled; never edit code itself.',
      policy: 'Linux VM sandbox policy',
      policyHint: 'The host has no per-Bot sandbox field yet, so the policy is recorded as a trailing “沙箱策略：…” line in the instructions, which the host reads back from there.',
      'policy.on-demand': 'On demand',
      'policy.on-demand.why': 'A Linux machine starts when an issue arrives and is reclaimed with it.',
      'policy.always': 'Always on',
      'policy.always.why': 'The Bot gets a dedicated machine as soon as it exists.',
      'policy.none': 'No VM',
      'policy.none.why': 'No machine is started; the Bot works on the host.',
      create: 'Create Bot',
      cancel: 'Cancel',
      cancelled: 'Creation cancelled: no Bot was made.',
    }

    const DICTIONARIES = { en, zh }

    /**
     * One translate function bound to a locale id, with `{name}` substitution.
     * @param {string | undefined} active - the active locale id.
     * @returns {(key: string, params?: Record<string, unknown>) => string} translator.
     */
    function translator(active) {
      const dict = DICTIONARIES[active] ?? DICTIONARIES.en
      return (key, params) => {
        let text = dict[key] ?? DICTIONARIES.en[key] ?? key
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
        }
        return text
      }
    }

    /** Label and reason for one policy value, in the current locale. */
    function describePolicy(t, policy) {
      return { label: t(`policy.${policy}`), why: t(`policy.${policy}.why`) }
    }

    /**
     * The `instructions` the Bot is created with: the user's text, then the policy
     * line. The policy is a record, so it is written as a line a host-side reader
     * can match (`/^沙箱策略：(always|on-demand|none)/m`) and a human can read.
     * @param {{ text: string, policy: string }} answer - step two's answers.
     * @returns {string} the instructions to create the Bot with.
     */
    function composeInstructions({ text, policy }) {
      const chosen = POLICY_VALUES.has(policy) ? policy : DEFAULT_POLICY
      const clean = String(text ?? '').trim()
      const record = `沙箱策略：${chosen}（${POLICIES.find(entry => entry.value === chosen).label}）`
      return clean === '' ? record : `${clean}\n\n${record}`
    }

    /** An abort reason shaped the way `fetch` reports one. */
    function abortError() {
      if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError')
      return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    }

    /**
     * The answer a create request waits on, as a tiny external store: one pending
     * question at a time, and `confirm`/`cancel` from the UI settle it.
     * @returns the store the interceptor and the overlay share.
     */
    function createWizard() {
      let state = { open: false, name: '', seq: 0 }
      let pending = null
      const listeners = new Set()

      const publish = (next) => {
        state = next
        for (const listener of [...listeners]) listener()
      }

      /** Settle the pending question, once; a rejection is carried separately. */
      const finish = (outcome, error) => {
        const waiting = pending
        if (waiting === null) return
        pending = null
        waiting.cleanup()
        publish({ open: false, name: '', seq: state.seq })
        if (error === undefined) waiting.resolve(outcome)
        else waiting.reject(error)
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() {
          return state
        },
        /**
         * Ask step two for one create request.
         * @param {string} name - the Bot name step one collected, for the title.
         * @param {AbortSignal | undefined} signal - the request's own signal.
         * @returns {Promise<{ text: string, policy: string } | null>} the answers, or
         * `null` when the user cancelled and nothing should be created.
         */
        ask(name, signal) {
          // A second create cannot happen while a question is open; settling the
          // stale one as a cancel keeps this store to a single waiter.
          if (pending !== null) finish(null)
          if (signal?.aborted === true) return Promise.reject(abortError())
          return new Promise((resolve, reject) => {
            const onAbort = () => finish(null, abortError())
            signal?.addEventListener?.('abort', onAbort)
            pending = {
              resolve,
              reject,
              cleanup: () => signal?.removeEventListener?.('abort', onAbort),
            }
            publish({ open: true, name: String(name ?? ''), seq: state.seq + 1 })
          })
        },
        confirm(text, policy) {
          finish({ text: String(text ?? ''), policy: POLICY_VALUES.has(policy) ? policy : DEFAULT_POLICY })
        },
        cancel() {
          finish(null)
        },
      }
    }

    /** True when this URL is the Bot RPC route, whatever the base path is. */
    function isBotRoute(input) {
      if (typeof input !== 'string' || input === '') return false
      try {
        const url = new URL(input, document.baseURI)
        return url.origin === window.location.origin && new RegExp(`(^|/)${ROUTE}$`).test(url.pathname)
      } catch {
        return false
      }
    }

    /**
     * Read a create request out of a `fetch` call, or `undefined` when this call is
     * not one. Only the string-body shape `api.js` sends is understood; anything
     * else passes through, because guessing at a `Request` body would mean
     * consuming it.
     */
    function readCreate(input, init) {
      if (!isBotRoute(input)) return undefined
      if (typeof init?.body !== 'string') return undefined
      const method = String(init?.method ?? 'POST').toUpperCase()
      if (method !== 'POST') return undefined
      let body
      try {
        body = JSON.parse(init.body)
      } catch {
        return undefined
      }
      if (body?.endpoint !== CREATE) return undefined
      const payload = body.payload !== null && typeof body.payload === 'object' ? body.payload : {}
      return { body, payload }
    }

    /** A refusal `api.js` already knows how to show: `ok: false`, a code, a message. */
    function refusal(message) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'bot/refused', message } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    /**
     * Install the create-request wrapper and hand back its undo.
     * @param wizard - the store the overlay answers through.
     * @param t - translator, read at call time so the message follows the locale.
     * @returns {() => void} restores the fetch that was there before.
     */
    function installWrapper(wizard, t) {
      const original = window.fetch
      if (typeof original !== 'function') return () => {}

      const wrapped = function (input, init) {
        const request = readCreate(input, init)
        if (request === undefined) return original.call(window, input, init)
        return (async () => {
          const answer = await wizard.ask(request.payload.name, init?.signal)
          if (answer === null) return refusal(t('cancelled'))
          return original.call(window, input, {
            ...init,
            body: JSON.stringify({
              ...request.body,
              payload: { ...request.payload, instructions: composeInstructions(answer) },
            }),
          })
        })()
      }

      window.fetch = wrapped
      return () => {
        if (window.fetch === wrapped) window.fetch = original
      }
    }

    const CSS = `
.omd-bw-layer {
  position: fixed; inset: 0; z-index: 120;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; box-sizing: border-box;
  font-family: var(--dsw-font-family, system-ui, -apple-system, sans-serif);
}
.omd-bw-scrim {
  position: absolute; inset: 0;
  background: rgba(0, 0, 0, 0.42);
  animation: omd-bw-fade 140ms ease-out;
}
.omd-bw-card {
  position: relative;
  width: min(560px, 92vw); max-height: min(86vh, 720px);
  display: flex; flex-direction: column; gap: 14px;
  padding: 20px 22px; box-sizing: border-box;
  overflow-y: auto;
  color: var(--dsw-alias-label-primary, #151515);
  /* --dsw-alias-bg-overlay is a mid grey in the dark theme (#61666b); the
     layer token is the solid surface DS-Bot's own dialogs use. */
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #ffffff));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  border-radius: var(--dsw-radius-lg, 14px);
  box-shadow: 0 24px 64px -16px rgba(0, 0, 0, 0.32);
  animation: omd-bw-rise 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.omd-bw-head { display: flex; flex-direction: column; gap: 3px; }
.omd-bw-step { font-size: 11px; letter-spacing: 0.04em; color: var(--dsw-alias-label-tertiary, #85837f); }
.omd-bw-title { font-size: 15px; font-weight: 600; line-height: 22px; }
.omd-bw-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #5f5e5a); }
.omd-bw-field { display: flex; flex-direction: column; gap: 6px; border: 0; margin: 0; padding: 0; }
.omd-bw-label { font-size: 13px; font-weight: 600; }
.omd-bw-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #85837f); }
.omd-bw-textarea {
  width: 100%; min-height: 132px; box-sizing: border-box; resize: vertical;
  padding: 9px 10px; font: inherit; font-size: 13px; line-height: 19px;
  color: inherit; background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.03));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  border-radius: var(--dsw-radius-md, 10px); outline: none;
}
.omd-bw-textarea:focus { border-color: var(--dsw-alias-brand-primary, #4b6bff); }
.omd-bw-choices { display: flex; flex-direction: column; gap: 6px; }
.omd-bw-choice {
  display: flex; gap: 9px; align-items: flex-start;
  padding: 9px 11px; cursor: pointer; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.02));
}
.omd-bw-choice[data-picked="true"] {
  border-color: var(--dsw-alias-brand-primary, #4b6bff);
  background: var(--dsw-alias-state-business-tertiary, rgba(75, 107, 255, 0.08));
}
.omd-bw-choice input { margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary, #4b6bff); }
.omd-bw-choice-text { display: flex; flex-direction: column; gap: 1px; }
.omd-bw-choice-label { font-size: 13px; font-weight: 600; }
.omd-bw-choice-why { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary, #5f5e5a); }
.omd-bw-foot { display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px; }
.omd-bw-button {
  padding: 6px 14px; border-radius: 8px; font: inherit; font-size: 13px; cursor: pointer;
  border: 1px solid color-mix(in oklab, currentColor 20%, transparent);
  background: transparent; color: inherit;
}
.omd-bw-button[data-primary="true"] {
  background: color-mix(in oklab, currentColor 12%, transparent); font-weight: 600;
}
@keyframes omd-bw-fade { from { opacity: 0; } }
@keyframes omd-bw-rise { from { opacity: 0; transform: translateY(8px) scale(0.99); } }
@media (prefers-reduced-motion: reduce) {
  .omd-bw-scrim, .omd-bw-card { animation: none; }
}
`

    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    /**
     * The step-two form. Mounted on `document.body`, so a locale change reaches it
     * through `ctx.locale`'s own subscription rather than the frame's.
     */
    function Wizard({ wizard, locale }) {
      const state = React.useSyncExternalStore(wizard.subscribe, wizard.getSnapshot, wizard.getSnapshot)
      const subscribeLocale = React.useCallback(listener => locale.subscribe(listener), [locale])
      const readLocale = React.useCallback(() => locale.getSnapshot().active, [locale])
      const active = React.useSyncExternalStore(subscribeLocale, readLocale, readLocale)
      const t = React.useMemo(() => translator(active), [active])
      const [text, setText] = React.useState('')
      const [policy, setPolicy] = React.useState(DEFAULT_POLICY)
      const field = React.useRef(null)
      const seq = state.seq
      const open = state.open

      // A new question starts empty: the previous Bot's answers are not this one's.
      React.useEffect(() => {
        setText('')
        setPolicy(DEFAULT_POLICY)
      }, [seq])
      React.useEffect(() => {
        if (open) field.current?.focus()
      }, [open, seq])
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          wizard.cancel()
        }
        window.addEventListener('keydown', onKey, true)
        return () => { window.removeEventListener('keydown', onKey, true) }
      }, [open, wizard])

      if (!open) return null

      return h('div', { className: 'omd-bw-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') }, [
        h('div', { key: 'scrim', className: 'omd-bw-scrim' }),
        h('form', {
          key: 'card',
          className: 'omd-bw-card',
          onSubmit: (event) => {
            event.preventDefault()
            wizard.confirm(text, policy)
          },
        }, [
          h('div', { key: 'head', className: 'omd-bw-head' }, [
            h('span', { key: 'step', className: 'omd-bw-step' }, t('step')),
            h('span', { key: 'title', className: 'omd-bw-title' }, t('title')),
            h('span', { key: 'sub', className: 'omd-bw-sub' },
              state.name === '' ? t('unnamed') : t('named', { name: state.name })),
          ]),
          h('label', { key: 'notes', className: 'omd-bw-field' }, [
            h('span', { key: 'label', className: 'omd-bw-label' }, t('notes')),
            h('textarea', {
              key: 'input',
              ref: field,
              className: 'omd-bw-textarea',
              value: text,
              placeholder: t('notesPlaceholder'),
              onChange: (event) => { setText(event.target.value) },
            }),
            h('span', { key: 'hint', className: 'omd-bw-hint' }, t('notesHint')),
          ]),
          h('fieldset', { key: 'policy', className: 'omd-bw-field' }, [
            h('legend', { key: 'label', className: 'omd-bw-label' }, t('policy')),
            h('div', { key: 'choices', className: 'omd-bw-choices' }, POLICIES.map(entry => {
              const copy = describePolicy(t, entry.value)
              return h('label', {
                key: entry.value,
                className: 'omd-bw-choice',
                'data-picked': policy === entry.value ? 'true' : 'false',
              }, [
                h('input', {
                  key: 'radio',
                  type: 'radio',
                  name: 'omd-bw-policy',
                  value: entry.value,
                  checked: policy === entry.value,
                  onChange: () => { setPolicy(entry.value) },
                }),
                h('span', { key: 'text', className: 'omd-bw-choice-text' }, [
                  h('span', { key: 'label', className: 'omd-bw-choice-label' }, copy.label),
                  h('span', { key: 'why', className: 'omd-bw-choice-why' }, copy.why),
                ]),
              ])
            })),
            h('span', { key: 'hint', className: 'omd-bw-hint' }, t('policyHint')),
          ]),
          h('div', { key: 'foot', className: 'omd-bw-foot' }, [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'omd-bw-button',
              onClick: () => { wizard.cancel() },
            }, t('cancel')),
            h('button', {
              key: 'create',
              type: 'submit',
              className: 'omd-bw-button',
              'data-primary': 'true',
            }, t('create')),
          ]),
        ]),
      ])
    }

    /**
     * Mount the overlay on `document.body` and install the request wrapper.
     * @param ctx - client plugin context carrying the locale registry.
     */
    function apply(ctx) {
      ctx.effect(installStyles, 'omd-bot-wizard: stylesheet')
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'omd-bot-wizard: dictionaries')

      const wizard = createWizard()
      // Read at call time: the refusal message follows a locale switch.
      const t = (key, params) => translator(ctx.locale.getSnapshot()?.active)(key, params)

      const host = document.createElement('div')
      host.className = 'omd-bw-root'
      document.body.appendChild(host)
      const root = ReactDOMClient.createRoot(host)
      root.render(h(Wizard, { wizard, locale: ctx.locale }))

      const restoreFetch = installWrapper(wizard, t)

      ctx.effect(() => () => {
        restoreFetch()
        wizard.cancel()
        root.unmount()
        host.remove()
      }, 'omd-bot-wizard: overlay and request wrapper')
    }

    exports.inject = ['locale']
    exports.apply = apply
    return module.exports
  },
})
