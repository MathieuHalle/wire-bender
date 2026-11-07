// The live board store, against a fake y-websocket provider and a server doc in the test.
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { ObservableV2 } from 'lib0/observable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { BoardFile } from '~core/schema'
import { boardToDoc, writeBoard } from '#shared/yboard'
import { createLiveBoard, type LiveProvider } from '../../app/composables/useLiveBoard'
import { mk, trail } from '../core/helpers'

/* eslint-disable @typescript-eslint/no-explicit-any -- the fake's event map */
class FakeProvider extends ObservableV2<any> implements LiveProvider {
  readonly doc = new Y.Doc()
  readonly awareness = new Awareness(this.doc)
  wsconnected = false
  synced = false
  destroyed = false

  constructor(readonly id: string) {
    super()
  }

  /** The socket opens and the server's state arrives. */
  goLive(server: Y.Doc) {
    this.wsconnected = true
    this.emit('status', [{ status: 'connected' }])
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(server), 'server')
    this.synced = true
    this.emit('sync', [true])
  }

  /** The server closes the socket. */
  close(code = 1006, reason = '') {
    this.wsconnected = false
    this.synced = false
    this.emit('connection-close', [{ code, reason }, this])
    this.emit('status', [{ status: 'disconnected' }])
  }

  override destroy() {
    this.destroyed = true
    super.destroy()
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function serverDoc(board: BoardFile, state = { revision: 3, canUndo: true, canRedo: false }) {
  const doc = new Y.Doc()
  boardToDoc(doc, board)
  const map = doc.getMap('server')
  for (const [k, v] of Object.entries(state)) map.set(k, v)
  return doc
}

/** Server-side changes reach the client doc as one update. */
function push(server: Y.Doc, client: Y.Doc, change: () => void) {
  const before = Y.encodeStateVector(client)
  change()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server, before), 'server')
}

function setup() {
  const providers: FakeProvider[] = []
  const notes: string[] = []
  const posts: string[] = []
  const live = createLiveBoard(ref('b1'), {
    connect: (id) => {
      const p = new FakeProvider(id)
      providers.push(p)
      return p
    },
    post: async (url) => {
      posts.push(url)
    },
    notify: m => notes.push(m)
  })
  live.start()
  return { live, providers, notes, posts, last: () => providers.at(-1)! }
}

const start = mk({ trails: [trail('T1', ['A1', 'A2'])] })
const withT2 = (b: BoardFile): BoardFile => ({ ...b, trails: [...b.trails, trail('T2', ['C1', 'C3'])] })

describe('useLiveBoard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('apply is refused while offline', () => {
    const { live, last } = setup()
    expect(live.status.value).toBe('connecting')
    expect(live.readOnly.value).toBe(true)
    expect(live.apply(withT2(start))).toBe(false)

    const server = serverDoc(start)
    last().goLive(server)
    expect(live.status.value).toBe('live')
    expect(live.readOnly.value).toBe(false)

    const doc = last().doc
    last().close()
    expect(live.status.value).toBe('offline')
    expect(live.readOnly.value).toBe(true)
    let writes = 0
    doc.on('update', () => writes++)
    expect(live.apply(withT2(live.board.value!))).toBe(false)
    expect(writes).toBe(0)
    // The board stays on screen while offline.
    expect(live.board.value!.trails.map(t => t.id)).toEqual(['T1'])
  })

  it('apply writes only the diff', () => {
    const { live, last } = setup()
    last().goLive(serverDoc(start))
    const changed: string[] = []
    const doc = last().doc
    for (const [name, type] of doc.share) {
      (type as Y.Map<unknown>).observe(e => changed.push(...[...e.keysChanged].map(k => `${name}:${k}`)))
    }
    const next = withT2(live.board.value!)
    expect(live.apply(next)).toBe(true)
    expect(changed).toEqual(['trails:T2'])
    expect(live.board.value).toBe(next)
  })

  it('a remote change updates board', () => {
    const { live, last } = setup()
    const server = serverDoc(start)
    last().goLive(server)
    expect(live.board.value!.trails.map(t => t.id)).toEqual(['T1'])
    push(server, last().doc, () => writeBoard(server, start, withT2(start)))
    expect(live.board.value!.trails.map(t => t.id)).toEqual(['T1', 'T2'])
  })

  it('server map drives revision, canUndo, canRedo', () => {
    const { live, last } = setup()
    const server = serverDoc(start)
    last().goLive(server)
    expect([live.revision.value, live.canUndo.value, live.canRedo.value]).toEqual([3, true, false])
    push(server, last().doc, () => {
      const map = server.getMap('server')
      server.transact(() => {
        map.set('revision', 4)
        map.set('canUndo', false)
        map.set('canRedo', true)
      })
    })
    expect([live.revision.value, live.canUndo.value, live.canRedo.value]).toEqual([4, false, true])
  })

  it('every reconnect gets a fresh doc; 4400 shows the reason; 4404 stops', async () => {
    const { live, providers, notes, last } = setup()
    last().goLive(serverDoc(start))
    const first = last()

    first.close(1006)
    expect(first.destroyed).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(providers).toHaveLength(2)
    expect(last().doc).not.toBe(first.doc)
    expect(live.status.value).toBe('connecting')

    last().goLive(serverDoc(start))
    last().close(4400, 'trails.T9: bad hole')
    expect(notes).toEqual(['trails.T9: bad hole'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(providers).toHaveLength(3)

    last().close(4404, 'no such board')
    await vi.advanceTimersByTimeAsync(3000)
    expect(providers).toHaveLength(3)
    expect(live.missing.value).toBe(true)
    expect(live.status.value).toBe('offline')
  })

  it('undo and redo POST to the board, and say why when there is nothing to do', async () => {
    const providers: FakeProvider[] = []
    const notes: string[] = []
    const posts: string[] = []
    const live = createLiveBoard(ref('b1'), {
      connect: (id) => {
        const p = new FakeProvider(id)
        providers.push(p)
        return p
      },
      post: async (url) => {
        posts.push(url)
        if (url.endsWith('/redo')) throw Object.assign(new Error('409'), { data: { reason: 'nothing to redo' } })
      },
      notify: m => notes.push(m)
    })
    live.start()
    providers[0]!.goLive(serverDoc(start))
    await live.undo()
    await live.redo()
    expect(posts).toEqual(['/api/boards/b1/undo', '/api/boards/b1/redo'])
    expect(notes).toEqual(['nothing to redo'])
  })

  it('undo and redo do nothing, and do not POST, while read-only', async () => {
    const { live, posts } = setup()
    expect(live.readOnly.value).toBe(true)
    await live.undo()
    await live.redo()
    expect(posts).toEqual([])
  })

  it('a new id resets the board, the revision and the undo state', async () => {
    const id = ref('b1')
    const providers: FakeProvider[] = []
    const live = createLiveBoard(id, {
      connect: (b) => {
        const p = new FakeProvider(b)
        providers.push(p)
        return p
      },
      post: async () => {},
      notify: () => {}
    })
    live.start()
    const server = serverDoc(start)
    const map = server.getMap('server')
    map.set('revision', 4)
    map.set('canUndo', true)
    providers.at(-1)!.goLive(server)
    expect(live.revision.value).toBe(4)
    expect(live.canUndo.value).toBe(true)
    id.value = 'b2'
    await nextTick()
    expect(live.board.value).toBeNull()
    expect(live.revision.value).toBe(0)
    expect(live.canUndo.value).toBe(false)
    expect(live.canRedo.value).toBe(false)
  })

  it('undo and redo do nothing, and do not POST, while read-only', async () => {
    const { live, posts } = setup()
    expect(live.readOnly.value).toBe(true)
    await live.undo()
    await live.redo()
    expect(posts).toEqual([])
  })

  it('a new id resets the board, the revision and the undo state', async () => {
    const id = ref('b1')
    const providers: FakeProvider[] = []
    const live = createLiveBoard(id, {
      connect: (b) => {
        const p = new FakeProvider(b)
        providers.push(p)
        return p
      },
      post: async () => {},
      notify: () => {}
    })
    live.start()
    providers.at(-1)!.goLive(serverDoc(start, { revision: 4, canUndo: true, canRedo: true }))
    expect(live.revision.value).toBe(4)
    expect(live.canUndo.value).toBe(true)
    id.value = 'b2'
    await nextTick()
    expect(live.board.value).toBeNull()
    expect(live.revision.value).toBe(0)
    expect(live.canUndo.value).toBe(false)
    expect(live.canRedo.value).toBe(false)
  })

  it('peers come from awareness; the local user is "Local · This computer"', () => {
    const { live, last } = setup()
    last().goLive(serverDoc(start))
    const local = last().awareness.getLocalState() as { user: { name: string, color: string } }
    expect(local.user.name).toBe('Local · This computer')
    expect(local.user.color).toMatch(/^#[0-9a-f]{6}$/)

    const other = new Awareness(new Y.Doc())
    other.setLocalStateField('user', { name: 'Local · Tablet', color: '#123456' })
    applyAwarenessUpdate(last().awareness, encodeAwarenessUpdate(other, [other.clientID]), 'remote')
    expect(live.peers.value).toEqual([{ name: 'Local · Tablet', color: '#123456' }])
  })

  it('setDevice names this device in presence, now and after a reconnect', () => {
    const { live, last, providers } = setup()
    last().goLive(serverDoc(start))
    live.setDevice('Bench tablet')
    const name = () => (last().awareness.getLocalState() as { user: { name: string } }).user.name
    expect(name()).toBe('Local · Bench tablet')
    last().close()
    vi.advanceTimersByTime(3000)
    expect(providers).toHaveLength(2)
    expect(name()).toBe('Local · Bench tablet')
  })

  it('close 4401 (unpaired) calls unpaired and stops reconnecting', () => {
    const providers: FakeProvider[] = []
    let unpaired = 0
    const live = createLiveBoard(ref('b1'), {
      connect: (id) => {
        const p = new FakeProvider(id)
        providers.push(p)
        return p
      },
      post: async () => {},
      notify: () => {},
      unpaired: () => unpaired++
    })
    live.start()
    providers[0]!.goLive(serverDoc(start))
    providers[0]!.close(4401, 'device unpaired')
    vi.advanceTimersByTime(10_000)
    expect(unpaired).toBe(1)
    expect(providers).toHaveLength(1)
    expect(live.status.value).toBe('offline')
  })
})
