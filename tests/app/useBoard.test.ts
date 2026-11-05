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
let calls: { method: string, body?: { baseRevision: number, board: BoardFile } }[]
let holdPut: Promise<void> | null

const fail = (status: number, data: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status }, data })

beforeEach(() => {
  vi.useFakeTimers()
  disk = { board: mk({ name: 'disk' }), errors: null }
  calls = []
  holdPut = null
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('$fetch', async (_url: string, opts?: { method?: string, body?: { baseRevision: number, board: BoardFile } }) => {
    const method = opts?.method ?? 'GET'
    calls.push({ method, body: opts?.body })
    if (method === 'GET') {
      if (disk.errors) throw fail(422, { path: '/x.json', errors: disk.errors })
      return { path: '/x.json', board: structuredClone(disk.board) }
    }
    if (holdPut) await holdPut
    const cur = disk.errors ? null : disk.board!.revision
    if (cur !== opts!.body!.baseRevision) throw fail(409, { current: cur })
    disk.board = { ...structuredClone(opts!.body!.board), revision: cur! + 1 }
    return { revision: cur! + 1 }
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

  test('older revisions are ignored without a fetch', async () => {
    disk.board!.revision = 5
    const s = await started()
    const n = calls.length
    FakeES.last!.emit({ revision: 4 })
    await flush()
    expect(calls.length).toBe(n)
    expect(s.revision.value).toBe(5)
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
