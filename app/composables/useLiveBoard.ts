// The open board, live on the server's Yjs room at /_ws/board/<id>.
//
// - Every (re)connect builds a fresh Y.Doc and provider: a room the server reopened has a
//   new doc, and an old client doc would carry stale history the server rejects. A copy
//   that lost its connection is read-only (no edit is queued); edits sent in the instant a
//   connection drops can be lost, since the fresh doc on reconnect starts from the server's
//   (ruling R6).
// - The role (owner, edit, view) is read from GET /api/boards/:key before every connect:
//   the first, every reconnect (after any close, a 4400 or a 4403 included) and `retry`.
//   A view copy never writes: no edits, no undo or redo (canEdit), so the server never has
//   a reason to close it for writing.
// - Close 4404 (no such board) stops reconnecting. Close 4400 (a rejected update) shows
//   the reason, then reconnects fresh like any other close. Close 4403 (access changed: a
//   sharing change, the trash, a deleted account) reconnects fresh once, with the role read
//   again; denied again before that connection syncs (4403 or 4404, or a read that finds
//   nothing), it shows NO_ACCESS and stops.
// - `apply` writes only the items that differ (writeBoard). Remote changes re-read the
//   board from the doc; the "server" map (written by the server only) gives the revision
//   and the shared undo stack.
// - `undo` and `redo` are commands on the socket (message type 3), so the server runs them
//   after this tab's edits sent before them. A command still unanswered when the socket
//   closes is reported (the server may have run it), not resent. Closing on purpose
//   (unmount, another board) reports nothing.
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { Awareness } from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { BoardFile } from '~core/schema'
import { MESSAGE_COMMAND, type LiveAnswer, type LiveCommand, type LiveOp } from '#shared/liveCommand'
import { docToBoard, writeBoard } from '#shared/yboard'

export type LiveStatus = 'connecting' | 'live' | 'offline'
/**
 * Someone in the presence list; `avatar` is what their copy says (shown only from known
 * hosts). `kind: 'token'` is an API token at work (the server says so): no avatar, TOKEN_COLOR.
 */
export interface Peer { name: string, color: string, avatar?: string, kind?: 'token' }

export type Role = 'owner' | 'edit' | 'view'

/** What GET /api/boards/:key says about the board, besides the board itself. */
export interface BoardMeta {
  role: Role
  name: string
  owner: { name: string }
  /** An edit link opened signed out: view now, edit after signing in. */
  signInToEdit: boolean
  forkedFrom: { key: string, name: string } | null
}

/** A role read: the board's meta, or why there is none (`error`: try again later). */
export type RoleRead = { ok: true, info: BoardMeta } | { ok: false, reason: 'password' | 'missing' | 'error' }

export const NO_ACCESS = 'You no longer have access to this board.'

/** The parts of a y-websocket provider the store uses (tests pass a fake). */
export interface LiveProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly wsconnected: boolean
  readonly synced: boolean
  /** The open socket, if any. */
  readonly ws: { send(data: Uint8Array): void } | null
  /** y-websocket's readers by message type; the store adds the command answer's. */
  messageHandlers: ((encoder: encoding.Encoder, decoder: decoding.Decoder, ...rest: never[]) => void)[]
  on(name: 'status' | 'sync' | 'connection-close', fn: (...args: never[]) => void): void
  destroy(): void
}

export interface LiveDeps {
  /** A new provider, on a new doc, connecting to board `id`. */
  connect(id: string): LiveProvider
  /** Shows a message (a toast in the app). */
  notify(message: string): void
  /** The device in the presence list: the paired device's name, or `This computer` on loopback. */
  deviceName?: string
  /** Called when the server says this device is no longer paired (close 4401). */
  unpaired?: () => void
  /** Reads the asker's role on board `id`. Without it (tests) nothing is read: the role stays `owner`. */
  readRole?: (id: string) => Promise<RoleRead>
}

const CLOSE_REJECTED = 4400
const CLOSE_UNTRUSTED = 4401
const CLOSE_ACCESS = 4403
const CLOSE_NO_BOARD = 4404
const MAX_BACKOFF_MS = 2500

/** The colour of an API token in presence (it sends none): a neutral slate. */
export const TOKEN_COLOR = '#64748b'

/** Presence colours; one is picked per tab. */
const COLORS = ['#e11d48', '#d97706', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#c026d3', '#475569']

/** Exported for tests; the app uses `useLiveBoard()`. */
export function createLiveBoard(id: Ref<string>, deps: LiveDeps) {
  const board = shallowRef<BoardFile | null>(null)
  const status = ref<LiveStatus>('connecting')
  const synced = ref(false)
  const missing = ref(false)
  const revision = ref(0)
  const canUndo = ref(false)
  const canRedo = ref(false)
  const peers = ref<Peer[]>([])
  const meta = shallowRef<BoardMeta | null>(null)
  const role = ref<Role>('owner')
  /** The link asks for its password (GET answered 401). */
  const needsPassword = ref(false)
  /** Access was lost while open: NO_ACCESS is shown, nothing reconnects. */
  const noAccess = ref(false)
  const readOnly = computed(() => !(status.value === 'live' && synced.value))
  /** Live and allowed to edit: a view copy never writes. */
  const canEdit = computed(() => !readOnly.value && role.value !== 'view')

  const user: Peer = { name: `Local · ${deps.deviceName ?? 'This computer'}`, color: COLORS[Math.floor(Math.random() * COLORS.length)]! }
  /** Marks our own writes, so they are not read back from the doc. */
  const LOCAL = Symbol('local')

  let provider: LiveProvider | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let stopWatch: (() => void) | null = null
  let nextCommand = 1
  /** A 4403 was answered with a fresh connection that has not synced yet. */
  let accessRetried = false
  /** Bumped by every new start of a connection: an older role read's answer is dropped. */
  let attempt = 0
  /** Commands sent on the current socket and not answered yet. */
  const waiting = new Map<number, { op: LiveOp, done: () => void }>()

  function readServer(doc: Y.Doc) {
    const map = doc.getMap('server')
    revision.value = (map.get('revision') as number | undefined) ?? 0
    canUndo.value = map.get('canUndo') === true
    canRedo.value = map.get('canRedo') === true
  }

  /** The board from the doc; an unparsable doc (not synced yet) keeps the last one. */
  function readBoard(doc: Y.Doc) {
    const r = docToBoard(doc, revision.value)
    if (r.ok) board.value = r.board
  }

  function readPeers(p: LiveProvider) {
    const list: Peer[] = []
    for (const [client, state] of p.awareness.getStates()) {
      const u = (state as { user?: Peer }).user
      if (client !== p.doc.clientID && u && typeof u.name === 'string') {
        if (u.kind === 'token') list.push({ name: u.name, color: TOKEN_COLOR, kind: 'token' })
        else list.push({ name: u.name, color: String(u.color), ...(typeof u.avatar === 'string' ? { avatar: u.avatar } : {}) })
      }
    }
    peers.value = list
  }

  function readState(p: LiveProvider) {
    status.value = p.wsconnected ? 'live' : 'connecting'
    synced.value = p.wsconnected && p.synced
    if (synced.value) {
      failures = 0
      accessRetried = false
    }
  }

  /** Stops for good on this key: access is gone. */
  function denied() {
    noAccess.value = true
    status.value = 'offline'
  }

  /** Waits, then starts again (a failed connection or role read). */
  function later() {
    failures++
    retry = setTimeout(begin, Math.min(100 * 2 ** failures, MAX_BACKOFF_MS))
  }

  /** Reads the role (if there is a reader), then connects. */
  function begin() {
    retry = null
    const n = ++attempt
    if (!deps.readRole) {
      open()
      return
    }
    drop(true)
    status.value = 'connecting'
    deps.readRole(id.value).then((r) => {
      if (n !== attempt) return
      if (r.ok) {
        meta.value = r.info
        role.value = r.info.role
        needsPassword.value = false
        open()
      } else if (r.reason === 'error') {
        status.value = 'offline'
        later()
      } else {
        status.value = 'offline'
        if (r.reason === 'password') needsPassword.value = true
        else if (accessRetried) denied()
        else missing.value = true
      }
    }, () => {
      if (n !== attempt) return
      status.value = 'offline'
      later()
    })
  }

  /** Closes the current connection; `quiet` when closing on purpose, so lost commands are not reported. */
  function drop(quiet = false) {
    if (!provider) return
    const p = provider
    provider = null
    p.destroy()
    p.awareness.destroy()
    p.doc.destroy()
    peers.value = []
    synced.value = false
    for (const { op, done } of waiting.values()) {
      if (!quiet) deps.notify(`${op} may not have reached the server; check the history`)
      done()
    }
    waiting.clear()
  }

  function answered(decoder: decoding.Decoder) {
    let reply: Partial<Record<keyof LiveAnswer, unknown>>
    try {
      reply = JSON.parse(decoding.readVarString(decoder))
    } catch {
      return
    }
    const w = typeof reply.id === 'number' ? waiting.get(reply.id) : undefined
    if (!w) return
    waiting.delete(reply.id as number)
    if (reply.ok !== true) deps.notify(typeof reply.reason === 'string' ? reply.reason : `${w.op} failed`)
    w.done()
  }

  function open() {
    retry = null
    // Only a new board id finds a connection still open here (a closed one was dropped).
    drop(true)
    const p = deps.connect(id.value)
    provider = p
    status.value = 'connecting'
    p.awareness.setLocalStateField('user', user)
    p.messageHandlers[MESSAGE_COMMAND] = (_encoder, decoder) => {
      if (provider === p) answered(decoder)
    }
    p.awareness.on('change', () => readPeers(p))
    p.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (provider !== p || tr.origin === LOCAL) return
      const server = p.doc.getMap('server')
      const types = [...tr.changed.keys()]
      if (types.includes(server as never)) readServer(p.doc)
      if (types.some(t => t !== (server as never))) readBoard(p.doc)
    })
    p.on('status', () => provider === p && readState(p))
    p.on('sync', () => {
      if (provider !== p) return
      readState(p)
      if (synced.value) {
        readServer(p.doc)
        readBoard(p.doc)
      }
    })
    p.on('connection-close', ((event: { code: number, reason: string } | null) => {
      if (provider !== p) return
      drop()
      status.value = 'offline'
      if (event?.code === CLOSE_NO_BOARD) {
        if (accessRetried) denied()
        else missing.value = true
        return
      }
      if (event?.code === CLOSE_ACCESS) {
        if (accessRetried) {
          denied()
          return
        }
        accessRetried = true
        begin()
        return
      }
      if (event?.code === CLOSE_UNTRUSTED) {
        deps.unpaired?.()
        return
      }
      if (event?.code === CLOSE_REJECTED) deps.notify(event.reason || 'The server rejected an edit.')
      later()
    }) as never)
    readState(p)
  }

  /** Writes `next` as item changes; false (and nothing written) while read-only or view only. */
  function apply(next: BoardFile): boolean {
    const p = provider
    const before = board.value
    if (!canEdit.value || !p || !before) return false
    writeBoard(p.doc, before, next, LOCAL)
    board.value = next
    return true
  }

  /** Sends an undo or redo command; resolves once the server answers (or the socket closes). */
  function call(op: LiveOp): Promise<void> {
    const ws = provider?.ws
    if (!canEdit.value || !ws) return Promise.resolve()
    const n = nextCommand++
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, MESSAGE_COMMAND)
    encoding.writeVarString(e, JSON.stringify({ op, id: n } satisfies LiveCommand))
    return new Promise((resolve) => {
      waiting.set(n, { op, done: resolve })
      try {
        ws.send(encoding.toUint8Array(e))
      } catch {
        waiting.delete(n)
        deps.notify(`${op} did not reach the server; try again`)
        resolve()
      }
    })
  }

  /** Names this device in the presence list (`Local · <name>`), now and on every reconnect. */
  function setDevice(name: string) {
    setPresence(`Local · ${name}`)
  }

  /** Who this copy is in the presence list (a signed-in name and avatar, or `Guest`), now and on every reconnect. */
  function setPresence(name: string, avatar?: string) {
    user.name = name
    if (avatar) user.avatar = avatar
    else delete user.avatar
    provider?.awareness.setLocalStateField('user', { ...user })
  }

  /** Starts this key again from its role read (after a link password was entered). */
  function restart() {
    if (retry) clearTimeout(retry)
    needsPassword.value = false
    noAccess.value = false
    missing.value = false
    accessRetried = false
    failures = 0
    begin()
  }

  /** Connects, and reconnects to the new board whenever `id` changes. */
  function start() {
    if (stopWatch) return
    stopWatch = watch(id, () => {
      board.value = null
      missing.value = false
      revision.value = 0
      canUndo.value = false
      canRedo.value = false
      meta.value = null
      role.value = 'owner'
      needsPassword.value = false
      noAccess.value = false
      accessRetried = false
      failures = 0
      if (retry) clearTimeout(retry)
      begin()
    }, { immediate: true })
  }

  function stop() {
    stopWatch?.()
    stopWatch = null
    if (retry) clearTimeout(retry)
    retry = null
    attempt++
    drop(true)
    status.value = 'offline'
  }

  return {
    board,
    status,
    readOnly,
    missing,
    revision: computed(() => revision.value),
    canUndo: computed(() => canUndo.value),
    canRedo: computed(() => canRedo.value),
    peers,
    meta,
    role: computed(() => role.value),
    canEdit,
    needsPassword,
    noAccess,
    apply,
    undo: () => call('undo'),
    redo: () => call('redo'),
    setDevice,
    setPresence,
    retry: restart,
    start,
    stop
  }
}

export type LiveBoard = ReturnType<typeof createLiveBoard>

/** GET /api/boards/:key as a role read. */
async function fetchRole(key: string, unpaired: () => void): Promise<RoleRead> {
  try {
    const r = await $fetch<BoardMeta>(`/api/boards/${encodeURIComponent(key)}`)
    return { ok: true, info: { role: r.role, name: r.name, owner: r.owner, signInToEdit: r.signInToEdit, forkedFrom: r.forkedFrom ?? null } }
  } catch (e) {
    const { statusCode, data } = e as { statusCode?: number, data?: { password?: unknown } }
    if (statusCode === 401 && data?.password === true) return { ok: false, reason: 'password' }
    if (statusCode === 404) return { ok: false, reason: 'missing' }
    // Local mode: this device is not paired (any more).
    if (statusCode === 401) {
      unpaired()
      return { ok: false, reason: 'missing' }
    }
    return { ok: false, reason: 'error' }
  }
}

/**
 * The board `key` (its id, or its share link id), live while the calling component is
 * mounted; nothing connects on the server. Presence is the paired device in local mode,
 * the signed-in name and avatar in public mode, else `Guest`.
 */
export function useLiveBoard(id: Ref<string>): LiveBoard {
  const warn = useWarning()
  const { load } = useMe()
  const unpaired = () => window.location.assign('/pair')
  const live = createLiveBoard(id, {
    connect: (boardId) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/_ws/board`
      // No BroadcastChannel: every tab syncs through the server, which validates each edit.
      return new WebsocketProvider(url, boardId, new Y.Doc(), { disableBc: true }) as unknown as LiveProvider
    },
    notify: warn,
    unpaired,
    readRole: key => fetchRole(key, unpaired)
  })
  let mounted = false
  onMounted(async () => {
    mounted = true
    // Who we are first, so the presence others see is right from the first connect.
    const me = await load()
    if (!mounted) return
    if (me?.mode === 'public') live.setPresence(me.user?.name ?? 'Guest', safeAvatar(me.user?.avatar))
    live.start()
    if (me?.mode !== 'public') $fetch<{ name: string }>('/api/devices/me').then(d => live.setDevice(d.name), () => {})
  })
  onBeforeUnmount(() => {
    mounted = false
    live.stop()
  })
  return live
}
