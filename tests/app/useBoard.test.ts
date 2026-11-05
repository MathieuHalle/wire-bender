// Client sync rules for useBoard, against a fake /api/board and a fake EventSource.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { BoardFile } from '~core/schema'
import { createBoardStore } from '../../app/composables/useBoard'
import { mk } from '../core/helpers'

class FakeES {
  static last: FakeES | null = null
  onopen: (() => void) | null = null
  private listeners: ((ev: { data: string }) => void)[] = []
  constructor(public url: string) {
    FakeES.last = this
  }

  addEventListener(_type: string, fn: (ev: { data: string }) => void) {
    this.listeners.push(fn)
  }

  emit(data: unknown) {
    for (const l of this.listeners) l({ data: JSON.stringify(data) })
  }
}

interface Disk { board: BoardFile | null, errors: string[] | null }
let disk: Disk
type PutBody = { baseRevision: number, baseHash: string, board: BoardFile }
let calls: { method: string, body?: PutBody, keepalive?: boolean }[]
let holdPut: Promise<void> | null

const fail = (status: number, data: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status }, data })
/** Stands in for the sha256 of the file bytes: any change to the file changes it. */
const hashOf = (b: BoardFile) => JSON.stringify(b)

/** The fake server's PUT, shared by $fetch and the keepalive fetch. */
async function serverPut(body: PutBody) {
  if (holdPut) await holdPut
  const cur = disk.errors ? null : disk.board!.revision
  const curHash = disk.errors ? null : hashOf(disk.board!)
  if (cur !== body.baseRevision || curHash !== body.baseHash) throw fail(409, { current: cur, hash: curHash })
  disk.board = { ...structuredClone(body.board), revision: cur! + 1 }
  return { revision: cur! + 1, hash: hashOf(disk.board) }
}

let win: EventTarget
/** Node's Event has a read-only returnValue; the browser's BeforeUnloadEvent lets you set it. */
class BeforeUnload extends Event {
  override returnValue: unknown = true
  constructor() {
    super('beforeunload', { cancelable: true })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  disk = { board: mk({ name: 'disk' }), errors: null }
  calls = []
  holdPut = null
  win = new EventTarget()
  vi.stubGlobal('window', win)
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('$fetch', async (_url: string, opts?: { method?: string, body?: PutBody }) => {
    const method = opts?.method ?? 'GET'
    calls.push({ method, body: opts?.body })
    if (method === 'GET') {
      if (disk.errors) throw fail(422, { path: '/x.json', errors: disk.errors })
      return { path: '/x.json', board: structuredClone(disk.board), hash: hashOf(disk.board!) }
    }
    return serverPut(opts!.body!)
  })
  vi.stubGlobal('fetch', async (_url: string, opts: { method: string, body: string, keepalive?: boolean }) => {
    const body = JSON.parse(opts.body) as PutBody
    calls.push({ method: opts.method, body, keepalive: opts.keepalive })
    try {
      const data = await serverPut(body)
      return { ok: true, status: 200, json: async () => data }
    } catch (e) {
      const x = e as { response: { status: number }, data: unknown }
      return { ok: false, status: x.response.status, json: async () => x.data }
    }
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const flush = () => vi.advanceTimersByTimeAsync(0)
const puts = () => calls.filter(c => c.method === 'PUT')

async function started() {
  const s = createBoardStore()
  s.start()
  await flush()
  return s
}

const edited = (b: BoardFile, name: string): BoardFile => ({ ...b, name })

describe('useBoard', () => {
  test('loads the board and its revision', async () => {
    disk.board!.revision = 7
    const s = await started()
    expect(s.board.value?.name).toBe('disk')
    expect(s.revision.value).toBe(7)
    expect(s.status.value).toBe('saved')
  })

  test('apply autosaves after 400 ms with baseRevision, then takes the new revision', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'mine'))
    expect(s.status.value).toBe('saving')
    await vi.advanceTimersByTimeAsync(399)
    expect(puts()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(puts()).toHaveLength(1)
    expect(puts()[0]!.body!.baseRevision).toBe(0)
    expect(s.revision.value).toBe(1)
    expect(s.status.value).toBe('saved')
  })

  test('the echo of our own save changes nothing and keeps history', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'mine'))
    await vi.advanceTimersByTimeAsync(400)
    const before = s.board.value
    FakeES.last!.emit({ revision: 1 })
    await flush()
    expect(s.board.value).toBe(before)
    expect(s.canUndo.value).toBe(true)
    expect(s.status.value).toBe('saved')
  })

  test('a lower-revision external revert while idle reloads', async () => {
    disk.board = { ...disk.board!, revision: 5 }
    const s = await started()
    disk.board = { ...disk.board, name: 'reverted', revision: 2 }
    FakeES.last!.emit({ revision: 2 })
    await flush()
    expect(s.board.value?.name).toBe('reverted')
    expect(s.revision.value).toBe(2)
    expect(s.status.value).toBe('saved')
  })

  test('our own echo while a newer edit is pending is not a conflict', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'one'))
    await vi.advanceTimersByTimeAsync(400)
    s.apply(edited(s.board.value!, 'two'))
    FakeES.last!.emit({ revision: 1 })
    await flush()
    expect(s.status.value).not.toBe('conflict')
    await vi.advanceTimersByTimeAsync(400)
    expect(s.status.value).toBe('saved')
    expect(disk.board!.name).toBe('two')
    expect(s.revision.value).toBe(2)
  })

  test('an edit during an in-flight PUT, then its echo, is not a conflict', async () => {
    const s = await started()
    let release!: () => void
    holdPut = new Promise(r => (release = r))
    s.apply(edited(s.board.value!, 'one'))
    await vi.advanceTimersByTimeAsync(400) // PUT in flight
    s.apply(edited(s.board.value!, 'two'))
    FakeES.last!.emit({ revision: 1 })
    await flush()
    holdPut = null
    release()
    await flush()
    expect(s.status.value).not.toBe('conflict')
    await vi.advanceTimersByTimeAsync(400)
    expect(s.status.value).toBe('saved')
    expect(disk.board!.name).toBe('two')
  })

  test('an edit landing while a check GET is in flight, then the echo, is not a conflict', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'one'))
    await vi.advanceTimersByTimeAsync(400)
    FakeES.last!.emit({ revision: 1 }) // GET starts
    s.apply(edited(s.board.value!, 'two')) // before it returns
    await flush()
    expect(s.status.value).not.toBe('conflict')
  })

  test('a same-revision external edit while an edit is pending is a conflict', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'mine'))
    disk.board = { ...disk.board!, name: 'hand edit' } // revision still 0
    FakeES.last!.emit({ revision: 0 })
    await flush()
    expect(s.status.value).toBe('conflict')
    await vi.advanceTimersByTimeAsync(1000)
    expect(puts()).toHaveLength(0)
    expect(disk.board.name).toBe('hand edit')
  })

  test('a same-revision hand edit before our save lands is refused by hash (409)', async () => {
    const s = await started()
    disk.board = { ...disk.board!, name: 'hand edit' } // no event yet
    s.apply(edited(s.board.value!, 'mine'))
    await vi.advanceTimersByTimeAsync(400)
    expect(s.status.value).toBe('conflict')
    expect(disk.board.name).toBe('hand edit')
  })

  test('checks are single-flight: a burst of events makes at most two GETs', async () => {
    const s = await started()
    const before = calls.filter(c => c.method === 'GET').length
    for (let i = 0; i < 5; i++) FakeES.last!.emit({ revision: 0 })
    await flush()
    expect(calls.filter(c => c.method === 'GET').length - before).toBeLessThanOrEqual(2)
    expect(s.status.value).toBe('saved')
  })

  test('closing the tab with an edit pending sends a keepalive PUT and asks to warn', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'last second'))
    const ev = new BeforeUnload()
    win.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    await flush()
    const last = calls.at(-1)!
    expect(last.method).toBe('PUT')
    expect(last.keepalive).toBe(true)
    expect(disk.board!.name).toBe('last second')
    expect(s.status.value).toBe('saved')
  })

  test('closing the tab with nothing pending does not warn', async () => {
    await started()
    const ev = new BeforeUnload()
    win.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })

  test('an external change with nothing pending reloads, even at the same revision', async () => {
    const s = await started()
    disk.board = { ...disk.board!, name: 'hand edit' } // revision still 0
    FakeES.last!.emit({ revision: 0 })
    await flush()
    expect(s.board.value?.name).toBe('hand edit')
    disk.board = { ...disk.board, name: 'claude', revision: 3 }
    FakeES.last!.emit({ revision: 3 })
    await flush()
    expect(s.board.value?.name).toBe('claude')
    expect(s.revision.value).toBe(3)
  })

  test('an external change while an edit is pending is a conflict; nothing is overwritten', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'mine'))
    disk.board = { ...disk.board!, name: 'claude', revision: 1 }
    FakeES.last!.emit({ revision: 1 })
    await flush()
    expect(s.status.value).toBe('conflict')
    expect(s.board.value?.name).toBe('mine')
    await vi.advanceTimersByTimeAsync(1000)
    expect(puts()).toHaveLength(0)
    expect(disk.board.name).toBe('claude')
  })

  test('a 409 from the server is a conflict', async () => {
    const s = await started()
    disk.board = { ...disk.board!, revision: 9 } // changed behind our back, no event yet
    s.apply(edited(s.board.value!, 'mine'))
    await vi.advanceTimersByTimeAsync(400)
    expect(s.status.value).toBe('conflict')
    expect(disk.board.name).toBe('disk')
  })

  test('an event during an in-flight PUT waits for it (our own write is not a conflict)', async () => {
    const s = await started()
    let release!: () => void
    holdPut = new Promise(r => (release = r))
    s.apply(edited(s.board.value!, 'mine'))
    await vi.advanceTimersByTimeAsync(400)
    FakeES.last!.emit({ revision: 1 }) // arrives before the PUT response
    await flush()
    expect(s.status.value).toBe('saving')
    release()
    await flush()
    expect(s.status.value).toBe('saved')
    expect(s.revision.value).toBe(1)
  })

  test('keepMine writes over the disk version using its revision', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'mine'))
    disk.board = { ...disk.board!, name: 'claude', revision: 4 }
    FakeES.last!.emit({ revision: 4 })
    await flush()
    expect(s.status.value).toBe('conflict')
    await s.keepMine()
    expect(puts().at(-1)!.body!.baseRevision).toBe(4)
    expect(disk.board.name).toBe('mine')
    expect(s.revision.value).toBe(5)
    expect(s.status.value).toBe('saved')
  })

  test('reloadFromDisk takes the disk version and resets history', async () => {
    const s = await started()
    s.apply(edited(s.board.value!, 'mine'))
    disk.board = { ...disk.board!, name: 'claude', revision: 2 }
    FakeES.last!.emit({ revision: 2 })
    await flush()
    await s.reloadFromDisk()
    expect(s.board.value?.name).toBe('claude')
    expect(s.status.value).toBe('saved')
    expect(s.canUndo.value).toBe(false)
  })

  test('a broken file shows its errors and keeps the last good board; fixing it clears them', async () => {
    const s = await started()
    disk.errors = ['not valid JSON: x']
    FakeES.last!.emit({ errors: true })
    await flush()
    expect(s.errors.value).toEqual(['not valid JSON: x'])
    expect(s.board.value?.name).toBe('disk')
    disk.errors = null
    FakeES.last!.emit({ revision: 0 })
    await flush()
    expect(s.errors.value).toEqual([])
    expect(s.status.value).toBe('saved')
  })

  test('reconnect refetches', async () => {
    const s = await started()
    disk.board = { ...disk.board!, name: 'while away', revision: 1 }
    FakeES.last!.onopen!()
    await flush()
    expect(s.board.value?.name).toBe('while away')
  })

  test('a save that failed on the network is retried after reconnect; its error stays until then', async () => {
    const s = await started()
    const real = (globalThis as unknown as { $fetch: (u: string, o?: { method?: string }) => Promise<unknown> }).$fetch
    vi.stubGlobal('$fetch', async (u: string, o?: { method?: string, body?: PutBody }) => {
      if (o?.method === 'PUT') {
        calls.push({ method: 'PUT', body: o.body })
        throw new Error('fetch failed')
      }
      return real(u, o)
    })
    s.apply(edited(s.board.value!, 'mine'))
    await vi.advanceTimersByTimeAsync(400)
    expect(s.status.value).toBe('error')
    expect(s.errorKind.value).toBe('save')
    expect(s.errors.value).toEqual(['save failed: fetch failed'])
    vi.stubGlobal('$fetch', real)
    FakeES.last!.onopen!()
    await flush()
    // The disk still matches what we last saw, so the retry is scheduled, error still shown.
    expect(s.errors.value).toEqual(['save failed: fetch failed'])
    await vi.advanceTimersByTimeAsync(400)
    expect(puts()).toHaveLength(2)
    expect(disk.board!.name).toBe('mine')
    expect(s.status.value).toBe('saved')
    expect(s.errors.value).toEqual([])
    expect(s.errorKind.value).toBeNull()
  })

  test('a new edit after a failed save keeps the error banner until a save succeeds', async () => {
    const s = await started()
    const real = (globalThis as unknown as { $fetch: (u: string, o?: { method?: string }) => Promise<unknown> }).$fetch
    vi.stubGlobal('$fetch', async (u: string, o?: { method?: string, body?: PutBody }) => {
      if (o?.method === 'PUT') throw new Error('fetch failed')
      return real(u, o)
    })
    s.apply(edited(s.board.value!, 'one'))
    await vi.advanceTimersByTimeAsync(400)
    s.apply(edited(s.board.value!, 'two'))
    expect(s.status.value).toBe('saving')
    expect(s.errors.value).toEqual(['save failed: fetch failed'])
    vi.stubGlobal('$fetch', real)
    await vi.advanceTimersByTimeAsync(400)
    expect(disk.board!.name).toBe('two')
    expect(s.errors.value).toEqual([])
  })

  test('a PUT that starts and finishes inside a check GET does not revert the edit', async () => {
    const s = await started()
    const real = (globalThis as unknown as { $fetch: (u: string, o?: { method?: string }) => Promise<unknown> }).$fetch
    let releaseGet: (() => void) | null = null
    let holdOne = true
    vi.stubGlobal('$fetch', async (u: string, o?: { method?: string, body?: PutBody }) => {
      if ((o?.method ?? 'GET') === 'GET' && holdOne) {
        holdOne = false
        const stale = await real(u, o) // read the disk now, answer later
        await new Promise<void>((r) => {
          releaseGet = r
        })
        return stale
      }
      return real(u, o)
    })
    s.apply(edited(s.board.value!, 'mine'))
    FakeES.last!.emit({ revision: 0 }) // check starts; its GET reads the old disk
    await flush()
    await vi.advanceTimersByTimeAsync(400) // our PUT runs and lands meanwhile
    expect(disk.board!.name).toBe('mine')
    releaseGet!()
    await flush()
    expect(s.board.value!.name).toBe('mine')
    expect(s.status.value).toBe('saved')
    expect(s.canUndo.value).toBe(true)
  })

  test('errorKind tells a broken file from a lost server', async () => {
    const s = await started()
    disk.errors = ['not valid JSON: x']
    FakeES.last!.emit({ errors: true })
    await flush()
    expect(s.errorKind.value).toBe('file')
    const real = (globalThis as unknown as { $fetch: (u: string, o?: { method?: string }) => Promise<unknown> }).$fetch
    vi.stubGlobal('$fetch', async () => {
      throw new Error('fetch failed')
    })
    FakeES.last!.onopen!()
    await flush()
    expect(s.errorKind.value).toBe('server')
    vi.stubGlobal('$fetch', real)
    disk.errors = null
    FakeES.last!.onopen!()
    await flush()
    expect(s.errorKind.value).toBeNull()
  })

  test('undo and redo; apply clears redo; history is capped at 100', async () => {
    const s = await started()
    const b0 = s.board.value!
    s.apply(edited(b0, 'one'))
    s.apply(edited(s.board.value!, 'two'))
    s.undo()
    expect(s.board.value?.name).toBe('one')
    s.redo()
    expect(s.board.value?.name).toBe('two')
    s.undo()
    s.apply(edited(s.board.value!, 'three'))
    expect(s.canRedo.value).toBe(false)
    for (let i = 0; i < 150; i++) s.apply(edited(s.board.value!, `n${i}`))
    let n = 0
    while (s.canUndo.value) {
      s.undo()
      n++
    }
    expect(n).toBe(100)
  })
})
