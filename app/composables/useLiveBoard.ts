// The open board, live on the server's Yjs room at /_ws/board/<id>.
//
// - Every (re)connect builds a fresh Y.Doc and provider: a room the server reopened has a
//   new doc, and an old client doc would carry stale history the server rejects. A copy
//   that lost its connection is read-only (no edit is queued), so nothing local is lost.
// - Close 4404 (no such board) stops reconnecting. Close 4400 (a rejected update) shows
//   the reason, then reconnects fresh like any other close.
// - `apply` writes only the items that differ (writeBoard). Remote changes re-read the
//   board from the doc; the "server" map (written by the server only) gives the revision
//   and the shared undo stack, which `undo` and `redo` drive through the API.
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { BoardFile } from '~core/schema'
import { docToBoard, writeBoard } from '#shared/yboard'

export type LiveStatus = 'connecting' | 'live' | 'offline'
export interface Peer { name: string, color: string }

/** The parts of a y-websocket provider the store uses (tests pass a fake). */
export interface LiveProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly wsconnected: boolean
  readonly synced: boolean
  on(name: 'status' | 'sync' | 'connection-close', fn: (...args: never[]) => void): void
  destroy(): void
}

export interface LiveDeps {
  /** A new provider, on a new doc, connecting to board `id`. */
  connect(id: string): LiveProvider
  /** POST to the API; rejects with `{ data: { reason } }` on a 409. */
  post(url: string): Promise<unknown>
  /** Shows a message (a toast in the app). */
  notify(message: string): void
  /** The device in the presence list: the paired device's name, or `This computer` on loopback. */
  deviceName?: string
  /** Called when the server says this device is no longer paired (close 4401). */
  unpaired?: () => void
}

const CLOSE_REJECTED = 4400
const CLOSE_UNTRUSTED = 4401
const CLOSE_NO_BOARD = 4404
const MAX_BACKOFF_MS = 2500

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
  const readOnly = computed(() => !(status.value === 'live' && synced.value))

  const user = { name: `Local · ${deps.deviceName ?? 'This computer'}`, color: COLORS[Math.floor(Math.random() * COLORS.length)]! }
  /** Marks our own writes, so they are not read back from the doc. */
  const LOCAL = Symbol('local')

  let provider: LiveProvider | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let stopWatch: (() => void) | null = null

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
      if (client !== p.doc.clientID && u && typeof u.name === 'string') list.push({ name: u.name, color: String(u.color) })
    }
    peers.value = list
  }

  function readState(p: LiveProvider) {
    status.value = p.wsconnected ? 'live' : 'connecting'
    synced.value = p.wsconnected && p.synced
    if (synced.value) failures = 0
  }

  function drop() {
    if (!provider) return
    const p = provider
    provider = null
    p.destroy()
    p.awareness.destroy()
    p.doc.destroy()
    peers.value = []
    synced.value = false
  }

  function open() {
    retry = null
    drop()
    const p = deps.connect(id.value)
    provider = p
    status.value = 'connecting'
    p.awareness.setLocalStateField('user', user)
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
        missing.value = true
        return
      }
      if (event?.code === CLOSE_UNTRUSTED) {
        deps.unpaired?.()
        return
      }
      if (event?.code === CLOSE_REJECTED) deps.notify(event.reason || 'The server rejected an edit.')
      failures++
      retry = setTimeout(open, Math.min(100 * 2 ** failures, MAX_BACKOFF_MS))
    }) as never)
    readState(p)
  }

  /** Writes `next` as item changes; false (and nothing written) while read-only. */
  function apply(next: BoardFile): boolean {
    const p = provider
    const before = board.value
    if (readOnly.value || !p || !before) return false
    writeBoard(p.doc, before, next, LOCAL)
    board.value = next
    return true
  }

  async function call(step: 'undo' | 'redo') {
    try {
      await deps.post(`/api/boards/${encodeURIComponent(id.value)}/${step}`)
    } catch (e) {
      const reason = (e as { data?: { reason?: unknown } }).data?.reason
      deps.notify(typeof reason === 'string' ? reason : `${step} failed: ${(e as Error).message}`)
    }
  }

  /** Names this device in the presence list (`Local · <name>`), now and on every reconnect. */
  function setDevice(name: string) {
    user.name = `Local · ${name}`
    provider?.awareness.setLocalStateField('user', user)
  }

  /** Connects, and reconnects to the new board whenever `id` changes. */
  function start() {
    if (stopWatch) return
    stopWatch = watch(id, () => {
      board.value = null
      missing.value = false
      failures = 0
      if (retry) clearTimeout(retry)
      open()
    }, { immediate: true })
  }

  function stop() {
    stopWatch?.()
    stopWatch = null
    if (retry) clearTimeout(retry)
    retry = null
    drop()
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
    apply,
    undo: () => call('undo'),
    redo: () => call('redo'),
    setDevice,
    start,
    stop
  }
}

export type LiveBoard = ReturnType<typeof createLiveBoard>

/** The board `id`, live while the calling component is mounted; nothing connects on the server. */
export function useLiveBoard(id: Ref<string>): LiveBoard {
  const toast = useToast()
  const live = createLiveBoard(id, {
    connect: (boardId) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/_ws/board`
      // No BroadcastChannel: every tab syncs through the server, which validates each edit.
      return new WebsocketProvider(url, boardId, new Y.Doc(), { disableBc: true }) as unknown as LiveProvider
    },
    post: url => $fetch(url, { method: 'POST' }),
    notify: m => toast.add({ title: m, color: 'warning', icon: 'i-lucide-ban' }),
    unpaired: () => window.location.assign('/pair')
  })
  onMounted(() => {
    live.start()
    $fetch<{ name: string }>('/api/devices/me').then(me => live.setDevice(me.name), () => {})
  })
  onBeforeUnmount(live.stop)
  return live
}
