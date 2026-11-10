// Browser half of omd-onlyne. Hand-authored, like every other omd client: the
// web shell splices these bytes into its module loader, so there is no build
// step to run and only platform modules may be requested.
//
// One surface: a relay from another Onlyne node lands in the session log as a
// `user/message` whose source is `{ kind: 'onlyne', form: 'relay', sender,
// thread, seq }`. The built-in message Definition projects every non-user
// source as a `context` row, which a Bot's flow leaves empty, so the relay
// would be invisible. This Definition gives that event its own node kind and
// the card below draws it.
//
// The card reads the session log and nothing else: no second store, no RPC, no
// network. `source` carries sender and thread; the delivery kind survives only
// in the host-rendered header line, so it is read back from the body.
//
// Second surface: the network drawer. A `网络` / `Network` tab in DS-Bot's Bot
// and group drawer reads this session's node back from `onlyne://directory` and
// its peers from `onlyne://neighbors`, both through `/api/paths`, and repaints
// while it stays open. Every value it shows is the host's answer; an address the
// answer does not carry reads as unpublished instead of being guessed.
window.__ModuleLoader__.load({
  id: 'omd-onlyne',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createElement: h } = React

    /** Node kind this file builds and renders. */
    const CARD_KIND = 'omdOnlyneMessage'
    /** Keyed slot every chat row is dispatched through. */
    const SLOT = 'conversation.chat.node'
    /** Locale namespace for this card's chrome. */
    const NS = 'omd.onlyne'
    const STYLE_OWNER = 'omd-onlyne/card'
    /** The host prefixes every relay body with this line. */
    const RELAY_PREFIX = '[onlyne] from '
    /** Second header line: `thread <alias> · seq <n> · <delivery kind>`. */
    const RELAY_DETAIL = /^thread (.+) \u00b7 seq \d+ \u00b7 (.+)$/
    /** Host route serving any internal address; the drawer reads the node through it. */
    const PATHS_ROUTE = '/api/paths'
    /** How often the open drawer re-reads the node while it stays mounted. */
    const NET_POLL_MS = 5000
    /**
     * The two spellings a node row is written in: this plugin's directory
     * builds `nodeId`/`baseUrl`, and the library's own neighbor rows are
     * `node_id`/`base_url`. One field, two authors, so both are read.
     */
    const NODE_ID_KEYS = ['nodeId', 'node_id']
    const BASE_URL_KEYS = ['baseUrl', 'base_url']

    const en = {
      'card.unknown': 'unknown node',
      'card.sender': 'Sender',
      'card.thread': 'Thread',
      'net.label': 'Network',
      'net.online': 'connected',
      'net.offline': 'unreachable',
      'net.loading': 'reading…',
      'net.inproc': 'in-process',
      'net.wire': 'over the wire',
      'net.node': 'node',
      'net.address': 'declared address',
      'net.fingerprint': 'key fingerprint',
      'net.peers': 'neighbors',
      'net.empty': 'no other node is live',
      'net.unpublished': 'not published',
      'net.verified': 'verified',
      'net.unverified': 'unverified',
      'net.neighborsFailed': 'neighbor read failed',
      'net.source.local': 'local',
      'net.source.trusted': 'trusted',
      'net.source.discovered': 'discovered',
      'net.refresh': 'Refresh',
    }

    const zh = {
      'card.unknown': '未知节点',
      'card.sender': '发送者',
      'card.thread': '线程',
      'net.label': '网络',
      'net.online': '已连接',
      'net.offline': '不可达',
      'net.loading': '读取中…',
      'net.inproc': '进程内',
      'net.wire': '跨网络',
      'net.node': '节点',
      'net.address': '声明地址',
      'net.fingerprint': '密钥指纹',
      'net.peers': '邻居',
      'net.empty': '暂时没有其他节点',
      'net.unpublished': '未公布',
      'net.verified': '已验证',
      'net.unverified': '未验证',
      'net.neighborsFailed': '邻居读取失败',
      'net.source.local': '本进程',
      'net.source.trusted': '已信任',
      'net.source.discovered': '已发现',
      'net.refresh': '刷新',
    }

    const CSS = `
.omd-onlyne-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 2px 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base-secondary, var(--dsw-alias-bg-base));
}
.omd-onlyne-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.omd-onlyne-chip {
  font: var(--dsw-font-markdown-code-block-small);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
}
.omd-onlyne-chipMuted { color: var(--dsw-alias-label-tertiary); }
.omd-onlyne-kind {
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-tertiary);
  text-transform: lowercase;
}
.omd-onlyne-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary, inherit);
}
.omd-onlyne-net {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, inherit);
}
.omd-onlyne-net-head { display: flex; align-items: center; gap: 8px; }
.omd-onlyne-net-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, #9a9a9a);
}
.omd-onlyne-net-dot[data-tone='online'] { background: var(--dsw-static-success-400, #3fbf7f); }
.omd-onlyne-net-dot[data-tone='offline'] { background: var(--dsw-alias-state-error-primary, #d64545); }
.omd-onlyne-net-title { font-size: 13px; font-weight: 600; }
.omd-onlyne-net-state { color: var(--dsw-alias-label-secondary); }
.omd-onlyne-net-refresh {
  margin-left: auto;
  padding: 2px 9px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.omd-onlyne-net-refresh:hover { color: var(--dsw-alias-label-primary, inherit); }
.omd-onlyne-net-rows { display: flex; flex-direction: column; }
.omd-onlyne-net-row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  padding: 4px 0;
}
.omd-onlyne-net-key { color: var(--dsw-alias-label-tertiary); }
.omd-onlyne-net-val {
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  overflow-wrap: anywhere;
}
.omd-onlyne-net-peers { display: flex; flex-direction: column; gap: 6px; }
.omd-onlyne-net-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  letter-spacing: 0.02em;
}
.omd-onlyne-net-chip { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.omd-onlyne-net-empty { color: var(--dsw-alias-label-tertiary); }
.omd-onlyne-net-peer {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 9px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base-secondary, transparent);
}
.omd-onlyne-net-peer-head { display: flex; align-items: center; gap: 7px; }
.omd-onlyne-net-peer-name { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); }
.omd-onlyne-net-peer-address { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.omd-onlyne-net-error {
  color: var(--dsw-alias-state-error-primary, #d64545);
  overflow-wrap: anywhere;
}
`

    /** Install this card's stylesheet once; the plugin's fiber owns its lifetime. */
    function installStyles() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_OWNER}"]`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.pluginCss = STYLE_OWNER
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    /** Concatenate the text blocks of one logged message. */
    function textOf(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n')
    }

    /**
     * Split the host header off a relay body.
     * @param text - the logged message text.
     * @returns the peer's own text and the delivery kind the header named.
     */
    function splitRelay(text) {
      if (!text.startsWith(RELAY_PREFIX)) return { body: text, delivery: undefined }
      const split = text.indexOf('\n\n')
      if (split < 0) return { body: text, delivery: undefined }
      const lines = text.slice(0, split).split('\n')
      const detail = lines.length > 1 ? RELAY_DETAIL.exec(lines[1]) : null
      const delivery = detail === null || detail[2] === undefined ? '' : detail[2].trim()
      return { body: text.slice(split + 2), delivery: delivery === '' ? undefined : delivery }
    }

    /** The identifying tail of an Onlyne id, cut to fit a chip. */
    function shortId(id, keep) {
      const cut = Math.max(id.lastIndexOf(':'), id.lastIndexOf('/'))
      const tail = cut < 0 ? id : id.slice(cut + 1)
      const name = tail === '' ? id : tail
      return name.length <= keep ? name : `${name.slice(0, keep)}\u2026`
    }

    /** `<owner>/<id>` with both halves shortened. */
    function shortAlias(alias) {
      const cut = alias.indexOf('/')
      if (cut < 0) return shortId(alias, 12)
      return `${shortId(alias.slice(0, cut), 10)}/${shortId(alias.slice(cut + 1), 12)}`
    }

    /** One logged relay, normalized so a malformed payload cannot blank the row. */
    function normalize(data) {
      const message = typeof data === 'object' && data !== null ? data : {}
      const source = typeof message.source === 'object' && message.source !== null ? message.source : {}
      const sender = typeof source.sender === 'string' ? source.sender : ''
      const thread = typeof source.thread === 'string' ? source.thread : ''
      const relay = splitRelay(textOf(message.content))
      return {
        sender,
        senderShort: sender === '' ? '' : shortId(sender, 10),
        thread,
        threadShort: thread === '' ? undefined : shortAlias(thread),
        delivery: relay.delivery,
        body: relay.body,
      }
    }

    /**
     * Whether one event is an appended relay.
     * A replacement over the same seq rewrites history and is not a new message.
     */
    function isRelay(event) {
      if (event.type !== 'user/message') return false
      if (typeof event.surfaceOp === 'object' && event.surfaceOp !== null) return false
      const data = event.data
      if (typeof data !== 'object' || data === null) return false
      const source = data.source
      return typeof source === 'object' && source !== null && source.kind === 'onlyne'
    }

    /** Identity extractor: one Definition context per relayed message. */
    function match(event) {
      return isRelay(event) ? { id: String(event.data.id), role: 'start' } : null
    }

    /** One message is one event, so there is nothing to fold. */
    function start(_context, matched) {
      return { ...normalize(matched.event.data), seq: matched.event.seq }
    }

    /** Where the message belongs; the engine already placed its event. */
    function locationOf(context) {
      return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
    }

    /** One relay: who sent it, where it landed, how it arrived, and what it said. */
    function OnlyneCard({ node, t }) {
      const card = node.data
      const head = [
        h('code', {
          key: 'sender',
          className: 'omd-onlyne-chip',
          title: card.sender === '' ? undefined : `${t('card.sender')}: ${card.sender}`,
        }, card.senderShort === '' ? t('card.unknown') : card.senderShort),
      ]
      if (card.threadShort !== undefined) {
        head.push(h('code', {
          key: 'thread',
          className: 'omd-onlyne-chip omd-onlyne-chipMuted',
          title: `${t('card.thread')}: ${card.thread}`,
        }, card.threadShort))
      }
      if (card.delivery !== undefined) {
        head.push(h('span', { key: 'delivery', className: 'omd-onlyne-kind' }, card.delivery))
      }
      return h('div', { className: 'omd-onlyne-card' },
        h('div', { className: 'omd-onlyne-head' }, head),
        card.body === '' ? null : h('div', { className: 'omd-onlyne-body' }, card.body))
    }

    // ------------------------------------------------------------------
    // Network drawer.
    // ------------------------------------------------------------------

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** The first non-empty string a row carries under one of `keys`. */
    function firstText(row, keys) {
      if (typeof row !== 'object' || row === null) return undefined
      for (const key of keys) {
        const value = row[key]
        if (typeof value === 'string' && value !== '') return value
      }
      return undefined
    }

    /** The node rows a directory or neighbor answer carries, whatever shape it names them in. */
    function rowList(body) {
      if (Array.isArray(body)) return body.filter(row => typeof row === 'object' && row !== null)
      if (typeof body !== 'object' || body === null) return []
      for (const list of [body.nodes, body.peers, body.neighbors, body.description?.nodes]) {
        if (Array.isArray(list)) return list.filter(row => typeof row === 'object' && row !== null)
      }
      return []
    }

    /** Which edge a declared address names: this process, the wire, or nothing yet. */
    function modeOf(address) {
      if (address === undefined) return 'unknown'
      try {
        const url = new URL(address)
        if (url.hostname === 'in-process.local') return 'inproc'
        if (url.protocol === 'http:' || url.protocol === 'https:') return 'wire'
      } catch {
        // An address that does not parse names no edge; the drawer says so by
        // omitting the mode instead of inventing one.
      }
      return 'unknown'
    }

    /** The node a directory answer speaks for: named by the answer, marked in it, or implied by the session. */
    function selfIdOf(body, sessionId, rows) {
      const named = firstText(body, ['self', ...NODE_ID_KEYS])
      if (named !== undefined) return named
      const marked = rows.find(row => row.isSelf === true || row.self === true)
      if (marked !== undefined) {
        const id = firstText(marked, NODE_ID_KEYS)
        if (id !== undefined) return id
      }
      return typeof sessionId === 'string' && sessionId !== '' ? `urn:onlyne:agent:${sessionId}` : undefined
    }

    /** One peer row, or null when the row is this node itself or names no identity. */
    function peerOf(row, self) {
      const nodeId = firstText(row, NODE_ID_KEYS)
      if (nodeId === undefined || nodeId === self) return null
      // The directory answers with a single source tier per node; the library's own
      // neighbor rows carry an array of the tables that named the peer. One tier is what
      // the badge has room to say, so the strongest one wins.
      const sources = Array.isArray(row.sources) ? row.sources : [row.source]
      const source = sources.find(value => value === 'local' || value === 'trusted' || value === 'discovered')
      return {
        nodeId,
        short: shortId(nodeId, 18),
        address: firstText(row, BASE_URL_KEYS),
        fingerprint: firstText(row, ['fingerprint']),
        verified: row.verified === true || row.phase === 'verified' || row.trust === 'verified',
        source: typeof source === 'string' ? source : undefined,
      }
    }

    /** Everything the drawer paints, derived from the two answers it read. */
    function netView(directory, neighbors, neighborsError, sessionId) {
      const rows = rowList(directory)
      const self = selfIdOf(directory, sessionId, rows)
      const own = self === undefined ? undefined : rows.find(row => firstText(row, NODE_ID_KEYS) === self)
      const address = own === undefined ? firstText(directory, BASE_URL_KEYS) : firstText(own, BASE_URL_KEYS)
      // A key fingerprint is published by the trust record, so a directory that
      // carries no key material leaves the row saying so instead of borrowing a peer's.
      const fingerprint = own === undefined ? undefined : firstText(own, ['fingerprint'])
      const listed = neighbors === undefined ? rows : rowList(neighbors)
      const tiers = new Map()
      for (const row of rows) {
        const id = firstText(row, NODE_ID_KEYS)
        const tier = firstText(row, ['source'])
        if (id !== undefined && tier !== undefined) tiers.set(id, tier)
      }
      const peers = []
      const seen = new Set()
      for (const row of listed) {
        const peer = peerOf(row, self)
        if (peer === null || seen.has(peer.nodeId)) continue
        if (peer.source === undefined) peer.source = tiers.get(peer.nodeId)
        seen.add(peer.nodeId)
        peers.push(peer)
      }
      peers.sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      return { self, address, fingerprint, peers, mode: modeOf(address), neighborsError }
    }

    /** Read one internal address through the browser's own channel. */
    async function readAddress(uri, sessionId, signal) {
      const query = new URLSearchParams({ uri })
      if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId)
      const response = await fetch(`${PATHS_ROUTE}?${query.toString()}`, {
        headers: { accept: 'application/json' },
        signal,
      })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = undefined }
      if (!response.ok) {
        const reason = typeof body === 'object' && body !== null && typeof body.error === 'string'
          ? body.error
          : `${PATHS_ROUTE} → ${response.status}`
        throw new Error(reason)
      }
      return body === undefined ? text : body
    }

    /** The dictionary the interface is in; the platform's locale service decides. */
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
      return React.useSyncExternalStore(subscribe, read, read)
    }

    /** One labelled line of the identity block. */
    function netRow(dict, key, value, missing) {
      return h('div', { className: 'omd-onlyne-net-row' },
        h('span', { className: 'omd-onlyne-net-key' }, dict[key]),
        h('span', { className: 'omd-onlyne-net-val' }, typeof value === 'string' && value !== '' ? value : missing))
    }

    /**
     * Install the Definition, the card seat, and the stylesheet.
     * @param ctx - client plugin context carrying the Conversation and Slot registries.
     */
    function apply(ctx) {
      /** The drawer's tab label, localized live. */
      function NetworkLabel() {
        return useDict(ctx)['net.label']
      }

      /**
       * The node identity, its declared endpoint, and its live peers.
       * Every value is the host's answer; a source that refuses leaves the
       * state line carrying its own wording.
       */
      function NetworkTab({ sessionId }) {
        const dict = useDict(ctx)
        const [attempt, setAttempt] = React.useState(0)
        const [state, setState] = React.useState({ phase: 'loading' })

        React.useEffect(() => {
          const controller = new AbortController()
          let live = true
          const read = async () => {
            try {
              const directory = await readAddress('onlyne://directory', sessionId, controller.signal)
              let neighbors
              let neighborsError
              try {
                neighbors = await readAddress('onlyne://neighbors', sessionId, controller.signal)
              } catch (error) {
                // The node publishes a neighbor list; a failure here is a fact about the
                // read, and hiding it behind the directory rows would show a partial
                // topology as if it were the whole one.
                if (controller.signal.aborted) return
                neighbors = undefined
                neighborsError = messageOf(error)
              }
              if (live) setState({ phase: 'ready', ...netView(directory, neighbors, neighborsError, sessionId) })
            } catch (error) {
              if (live) setState({ phase: 'offline', error: messageOf(error) })
            }
          }
          void read()
          const timer = setInterval(() => { void read() }, NET_POLL_MS)
          return () => {
            live = false
            clearInterval(timer)
            controller.abort()
          }
        }, [sessionId, attempt])

        const ready = state.phase === 'ready'
        const tone = state.phase === 'offline' ? 'offline' : ready ? 'online' : 'idle'
        const status = state.phase === 'loading'
          ? dict['net.loading']
          : state.phase === 'offline' ? dict['net.offline'] : dict['net.online']
        const mode = ready && state.mode === 'inproc'
          ? dict['net.inproc']
          : ready && state.mode === 'wire' ? dict['net.wire'] : ''
        return h('div', { className: 'omd-onlyne-net' },
          h('div', { className: 'omd-onlyne-net-head' },
            h('span', { className: 'omd-onlyne-net-dot', 'data-tone': tone }),
            h('span', { className: 'omd-onlyne-net-title' }, dict['net.label']),
            h('span', { className: 'omd-onlyne-net-state' }, mode === '' ? status : `${status} · ${mode}`),
            h('button', {
              type: 'button',
              className: 'omd-onlyne-net-refresh',
              onClick: () => setAttempt(count => count + 1),
            }, dict['net.refresh'])),
          h('div', { className: 'omd-onlyne-net-rows' },
            netRow(dict, 'net.node', ready ? state.self : undefined, '\u2014'),
            netRow(dict, 'net.address', ready ? state.address : undefined, '\u2014'),
            netRow(dict, 'net.fingerprint', ready ? state.fingerprint : undefined,
              ready ? dict['net.unpublished'] : '\u2014')),
          h('div', { className: 'omd-onlyne-net-peers' },
            h('div', { className: 'omd-onlyne-net-sub' },
              dict['net.peers'],
              ready ? h('span', { className: 'omd-onlyne-net-chip' }, String(state.peers.length)) : null),
            ready
              ? state.peers.length === 0
                ? h('div', { className: 'omd-onlyne-net-empty' }, dict['net.empty'])
                : state.peers.map(peer => h('div', { key: peer.nodeId, className: 'omd-onlyne-net-peer' },
                    h('div', { className: 'omd-onlyne-net-peer-head' },
                      h('span', {
                        className: 'omd-onlyne-net-dot',
                        'data-tone': peer.verified ? 'online' : 'idle',
                        title: peer.verified ? dict['net.verified'] : dict['net.unverified'],
                      }),
                      h('code', { className: 'omd-onlyne-net-peer-name', title: peer.nodeId }, peer.short)),
                    peer.address === undefined
                      ? null
                      : h('div', { className: 'omd-onlyne-net-val omd-onlyne-net-peer-address' }, peer.address),
                    peer.fingerprint === undefined
                      ? null
                      : h('div', { className: 'omd-onlyne-net-chip' }, peer.fingerprint),
                    peer.source === undefined
                      ? null
                      : h('span', { className: 'omd-onlyne-net-chip' }, dict[`net.source.${peer.source}`] ?? peer.source)))
              : null),
          ready && typeof state.neighborsError === 'string'
            ? h('div', { className: 'omd-onlyne-net-error' }, `${dict['net.neighborsFailed']}: ${state.neighborsError}`)
            : null,
          state.phase === 'offline' ? h('div', { className: 'omd-onlyne-net-error' }, state.error) : null)
      }

      ctx.effect(installStyles)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'omd-onlyne: dictionaries')

      ctx.uiConversation.events.register({
        kind: CARD_KIND,
        target: 'chat',
        match,
        start,
        update: start,
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
            groupTree: 'input',
            data: card,
          }
        },
      })

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        key: CARD_KIND,
        locale: NS,
      }, OnlyneCard))

      ctx.effect(() => {
        let cancelled = false
        let dispose
        const register = hub => {
          if (!cancelled) {
            dispose = hub.registerDetailsTab({
              id: 'omd-onlyne-network',
              label: NetworkLabel,
              component: NetworkTab,
              order: 25,
            })
          }
        }
        if (window.dshBot) register(window.dshBot)
        else (window.dshBotQueue ??= []).push(register)
        return () => {
          cancelled = true
          dispose?.()
        }
      }, 'omd-onlyne: network drawer tab')
    }

    exports.inject = ['slots', 'locale', 'uiConversation']
    exports.apply = apply
    return module.exports
  },
})
