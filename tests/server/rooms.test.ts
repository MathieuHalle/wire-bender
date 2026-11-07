import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { parseBoard, type BoardFile } from '../../core/schema'
import { openDb, type Db } from '../../server/db'
import { createBoard, getBoard, listRevisions } from '../../server/utils/boards'
import { GROUP_IDLE_MS, openRoom, type Room } from '../../server/utils/rooms'
import { docToBoard, writeBoard } from '../../shared/yboard'

let dir: string
let db: Db
let id: string
const clients: Client[] = []

function fixture(): BoardFile {
  const r = parseBoard(JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')))
  if (!r.ok) throw new Error(r.errors.join())
  return r.board
}

/** An in-memory Yjs doc wired to a room, as a browser tab would be. */
interface Client { peerId: string, author: string, doc: Y.Doc, awareness: Awareness, room: Room, last: { ok: boolean, reason?: string } | null, left: boolean }

function connect(peerId: string, author = 'Local'): Client {
  const room = openRoom(db, id)!
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const client: Client = { peerId, author, doc, awareness, room, last: null, left: false }
  room.join(peerId, author, {
    update: u => Y.applyUpdate(doc, u, 'remote'),
    awareness: u => applyAwarenessUpdate(awareness, u, 'remote')
  })
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc), 'remote')
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') client.last = room.receive(peerId, author, u)
  })
  clients.push(client)
  return client
}

function leave(c: Client): void {
  if (c.left) return
  c.left = true
  c.room.leave(c.peerId)
  c.awareness.destroy()
}

function boardOf(doc: Y.Doc): BoardFile {
  const r = docToBoard(doc, 0)
  if (!r.ok) throw new Error(r.errors.join())
  return { ...r.board, revision: 0 }
}

/** Edit a client's doc the way the editor would: one transaction with the diff. */
function edit(c: Client, change: (b: BoardFile) => BoardFile): void {
  const before = boardOf(c.doc)
  writeBoard(c.doc, before, change(structuredClone(before)))
}

function moveT7(to: string) {
  return (b: BoardFile): BoardFile => ({
    ...b,
    trails: b.trails.map(t => t.id === 'T7' ? { ...t, points: ['K3', to], joints: ['K3', to] } : t)
  })
}

const t7 = (b: BoardFile) => b.trails.find(t => t.id === 'T7')!.points

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-rooms-'))
  db = openDb(dir)
  id = createBoard(db, fixture(), 'create', 'Local').id
})
afterEach(() => {
  for (const c of clients.splice(0)) leave(c)
  vi.useRealTimers()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('rooms', () => {
  it('an accepted update reaches the other client and is saved', () => {
    const a = connect('a')
    const b = connect('b')
    edit(a, moveT7('L3'))
    expect(a.last).toEqual({ ok: true })
    expect(t7(boardOf(b.doc))).toEqual(['K3', 'L3'])
    expect(t7(getBoard(db, id)!.board)).toEqual(['K3', 'L3'])
  })

  it('invalid update is rejected and others are untouched', () => {
    const a = connect('a')
    const b = connect('b')
    edit(a, moveT7('Z99'))
    expect(a.last!.ok).toBe(false)
    expect(a.last!.reason).toMatch(/Z99/)
    expect(t7(boardOf(b.doc))).toEqual(['K3', 'M3'])
    expect(t7(boardOf(a.room.doc))).toEqual(['K3', 'M3'])
    expect(t7(getBoard(db, id)!.board)).toEqual(['K3', 'M3'])

    let result: ReturnType<Room['receive']> | undefined
    expect(() => {
      result = a.room.receive('a', 'Local', new Uint8Array([1, 2, 3, 255, 0, 7]))
    }).not.toThrow()
    expect(result!.ok).toBe(false)
    expect(a.room.receive('a', 'Local', new Uint8Array()).ok).toBe(false)
  })

  it('a client cannot write the server map', () => {
    const a = connect('a')
    const b = connect('b')
    a.doc.getMap('server').set('canUndo', true)
    expect(a.last!.ok).toBe(false)
    expect(a.last!.reason).toMatch(/server/)
    expect(b.doc.getMap('server').get('canUndo')).toBe(false)
    expect(a.room.doc.getMap('server').get('canUndo')).toBe(false)
  })

  it('updates group per author until 2 s idle', () => {
    vi.useFakeTimers()
    const a = connect('a', 'Alice')
    const b = connect('b', 'Bob')
    edit(a, moveT7('L3'))
    vi.advanceTimersByTime(400)
    edit(a, moveT7('N3'))
    vi.advanceTimersByTime(400)
    edit(a, moveT7('O3'))
    vi.advanceTimersByTime(GROUP_IDLE_MS - 1)
    expect(listRevisions(db, id)).toHaveLength(1)
    vi.advanceTimersByTime(1)
    const revs = listRevisions(db, id)
    expect(revs.map(r => [r.n, r.how, r.author])).toEqual([[2, 'edit', 'Alice'], [1, 'create', 'Local']])
    expect(b.doc.getMap('server').toJSON()).toEqual({ revision: 2, canUndo: true, canRedo: false })

    edit(a, moveT7('L3'))
    vi.advanceTimersByTime(300)
    edit(b, b => ({ ...b, name: 'renamed by Bob' }))
    vi.advanceTimersByTime(300)
    edit(a, moveT7('N3'))
    vi.advanceTimersByTime(300)
    edit(b, b => ({ ...b, name: 'renamed again' }))
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    expect(listRevisions(db, id).slice(0, 2).map(r => [r.n, r.how, r.author])).toEqual([[4, 'edit', 'Bob'], [3, 'edit', 'Alice']])
  })

  it('leaving closes that author\'s group, and the last leave drops the room', () => {
    vi.useFakeTimers()
    const a = connect('a', 'Alice')
    const b = connect('b', 'Bob')
    edit(a, moveT7('L3'))
    leave(a)
    expect(listRevisions(db, id)[0]).toMatchObject({ n: 2, how: 'edit', author: 'Alice' })
    expect(b.doc.getMap('server').get('revision')).toBe(2)
    const room = b.room
    leave(b)
    expect(openRoom(db, id)).not.toBe(room)
    openRoom(db, id)!.leave('nobody')
  })

  it('undo closes the open group first', () => {
    vi.useFakeTimers()
    const a = connect('a')
    const b = connect('b')
    edit(a, moveT7('L3'))
    vi.advanceTimersByTime(500)
    const n = a.room.undo('Local')
    expect(n).toBe(3)
    const revs = listRevisions(db, id)
    expect(revs.map(r => [r.n, r.how, r.target])).toEqual([[3, 'undo', 2], [2, 'edit', null], [1, 'create', null]])
    expect(t7(boardOf(b.doc))).toEqual(['K3', 'M3'])
    expect(t7(boardOf(a.doc))).toEqual(['K3', 'M3'])
    expect(b.doc.getMap('server').toJSON()).toEqual({ revision: 3, canUndo: false, canRedo: true })
    vi.advanceTimersByTime(GROUP_IDLE_MS * 2)
    expect(listRevisions(db, id)).toHaveLength(3)

    expect(a.room.undo('Local')).toBeNull()
    expect(a.room.redo('Local')).toBe(4)
    expect(t7(boardOf(b.doc))).toEqual(['K3', 'L3'])
    expect(listRevisions(db, id)[0]).toMatchObject({ n: 4, how: 'redo', target: 2 })
    expect(a.room.redo('Local')).toBeNull()
  })

  it('serverWrite reaches clients live and updates the server map', () => {
    const a = connect('a')
    const b = connect('b')
    expect(b.doc.getMap('server').toJSON()).toEqual({ revision: 1, canUndo: false, canRedo: false })
    const n = a.room.serverWrite({ ...fixture(), name: 'from the API' }, { author: 'Claude', how: 'api' })
    expect(n).toBe(2)
    expect(boardOf(a.doc).name).toBe('from the API')
    expect(boardOf(b.doc).name).toBe('from the API')
    expect(b.doc.getMap('server').toJSON()).toEqual({ revision: 2, canUndo: true, canRedo: false })
    expect(getBoard(db, id)!.board.name).toBe('from the API')
    expect(listRevisions(db, id)[0]).toMatchObject({ n: 2, how: 'api', author: 'Claude' })
  })

  it('a room with no peers is saved and dropped right after a server write', () => {
    const room = openRoom(db, id)!
    expect(room.serverWrite({ ...fixture(), name: 'no tab open' }, { author: 'Claude', how: 'api' })).toBe(2)
    expect(getBoard(db, id)!.board.name).toBe('no tab open')
    expect(openRoom(db, id)).not.toBe(room)
    expect(openRoom(db, id)!.undo('Claude')).toBe(3)
    expect(getBoard(db, id)!.board.name).toBe(fixture().name)
  })

  it('an unknown board has no room', () => {
    expect(openRoom(db, 'nope')).toBeNull()
  })

  it('relays awareness to the other peers and removes it on leave', () => {
    const a = connect('a')
    const b = connect('b')
    a.awareness.setLocalState({ user: { name: 'Local · This computer' } })
    a.room.receiveAwareness('a', encodeAwarenessUpdate(a.awareness, [a.doc.clientID]))
    expect(b.awareness.getStates().get(a.doc.clientID)).toEqual({ user: { name: 'Local · This computer' } })
    const c = connect('c')
    expect(c.awareness.getStates().get(a.doc.clientID)).toEqual({ user: { name: 'Local · This computer' } })
    leave(a)
    expect(b.awareness.getStates().has(a.doc.clientID)).toBe(false)
    expect(a.room.receiveAwareness('b', new Uint8Array([9, 9, 9])).ok).toBe(false)
  })
})
