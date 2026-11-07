import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { parseBoard, type BoardFile } from '../../core/schema'
import { openDb, type Db } from '../../server/db'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { createBoard, getBoard, getRevision, listRevisions } from '../../server/utils/boards'
import { GROUP_IDLE_MS, openRoom, type Room } from '../../server/utils/rooms'
import { MESSAGE_COMMAND, handleMessage } from '../../server/utils/liveMessage'
import { docToBoard, stable, writeBoard } from '../../shared/yboard'

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

    const c = connect('c')
    c.doc.getMap('server').delete('revision')
    expect(c.last!.ok).toBe(false)
    const d = connect('d')
    d.doc.getMap('server').set('nested', new Y.Map())
    expect(d.last!.ok).toBe(false)
    expect(b.doc.getMap('server').toJSON()).toEqual({ revision: 1, canUndo: false, canRedo: false })
    expect(a.room.doc.getMap('server').toJSON()).toEqual({ revision: 1, canUndo: false, canRedo: false })
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

    // Interleaved: each author's group commits only that author's items.
    edit(a, moveT7('L3'))
    vi.advanceTimersByTime(300)
    edit(b, b => ({ ...b, name: 'renamed by Bob' }))
    vi.advanceTimersByTime(300)
    edit(a, moveT7('N3'))
    vi.advanceTimersByTime(300)
    edit(b, b => ({ ...b, name: 'renamed again' }))
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    expect(listRevisions(db, id).slice(0, 2).map(r => [r.n, r.how, r.author])).toEqual([[4, 'edit', 'Bob'], [3, 'edit', 'Alice']])
    expect(getRevision(db, id, 3)!.board.name).toBe(fixture().name)
    expect(b.doc.getMap('server').get('revision')).toBe(4)

    // Interleaved, with Bob still editing after Alice's group closed: two revisions.
    edit(a, moveT7('L3'))
    vi.advanceTimersByTime(1000)
    edit(b, b => ({ ...b, name: 'renamed a third time' }))
    vi.advanceTimersByTime(1500)
    edit(b, b => ({ ...b, name: 'renamed a fourth time' }))
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    const last = listRevisions(db, id)
    expect(last.slice(0, 2).map(r => [r.n, r.how, r.author])).toEqual([[6, 'edit', 'Bob'], [5, 'edit', 'Alice']])
    const boards = last.map(r => stable({ ...getRevision(db, id, r.n)!.board, revision: 0 }))
    expect(new Set(boards).size).toBe(boards.length)
  })

  it('a group whose edits cancel out commits nothing', () => {
    vi.useFakeTimers()
    const a = connect('a')
    const b = connect('b')
    edit(a, moveT7('L3'))
    vi.advanceTimersByTime(500)
    edit(a, moveT7('M3'))
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    expect(listRevisions(db, id)).toHaveLength(1)
    expect(b.doc.getMap('server').toJSON()).toEqual({ revision: 1, canUndo: false, canRedo: false })
    edit(a, moveT7('L3'))
    edit(a, moveT7('M3'))
    leave(a)
    expect(listRevisions(db, id)).toHaveLength(1)
  })

  it('a peer whose link throws does not affect the room', () => {
    const a = connect('a')
    const room = a.room
    room.join('broken', 'Local', {
      update: () => {
        throw new Error('socket gone')
      },
      awareness: () => {
        throw new Error('socket gone')
      }
    })
    const b = connect('b')
    edit(a, moveT7('L3'))
    expect(a.last).toEqual({ ok: true })
    expect(t7(boardOf(b.doc))).toEqual(['K3', 'L3'])
    expect(t7(getBoard(db, id)!.board)).toEqual(['K3', 'L3'])
    a.awareness.setLocalState({ user: { name: 'A' } })
    expect(room.receiveAwareness('a', encodeAwarenessUpdate(a.awareness, [a.doc.clientID]))).toEqual({ ok: true })
    expect(b.awareness.getStates().get(a.doc.clientID)).toEqual({ user: { name: 'A' } })
    room.leave('broken')
  })

  it('a client cannot write outside the board\'s maps', () => {
    const a = connect('a')
    const b = connect('b')
    a.doc.getMap('junk').set('x', 1)
    expect(a.last).toEqual({ ok: false, reason: expect.stringMatching(/junk/) })
    expect(b.doc.share.has('junk')).toBe(false)
    expect(a.room.doc.share.has('junk')).toBe(false)
  })

  it('a client cannot override a section through the singles map', () => {
    const a = connect('a')
    const b = connect('b')
    const stored = stable(getBoard(db, id)!.board)
    a.doc.getMap('singles').set('parts', [])
    expect(a.last).toEqual({ ok: false, reason: expect.stringMatching(/parts/) })
    expect(stable(getBoard(db, id)!.board)).toBe(stored)
    expect(b.doc.getMap('singles').has('parts')).toBe(false)
    expect(a.room.doc.getMap('singles').has('parts')).toBe(false)
    expect(boardOf(a.room.doc).parts.length).toBe(fixture().parts.length)
  })

  it('a client cannot store an item under a key that is not its id', () => {
    const a = connect('a')
    const b = connect('b')
    const stored = stable(getBoard(db, id)!.board)
    const parts = a.doc.getMap<{ pos: number, v: { ref: string } }>('parts')
    const [key, entry] = [...parts.entries()][0]!
    parts.set(key, { pos: entry.pos, v: { ...entry.v, ref: 'ZZ9' } })
    expect(a.last).toEqual({ ok: false, reason: expect.stringMatching(new RegExp(`${key}.*ZZ9|ZZ9.*${key}`)) })
    expect(stable(getBoard(db, id)!.board)).toBe(stored)
    expect((b.doc.getMap<{ v: { ref: string } }>('parts').get(key))!.v.ref).toBe(key)
    expect((a.room.doc.getMap<{ v: { ref: string } }>('parts').get(key))!.v.ref).toBe(key)
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

  it('two authors\' interleaved edits commit under their own names', () => {
    vi.useFakeTimers()
    const a = connect('a', 'A')
    const b = connect('b', 'B')
    edit(a, moveT7('L3'))
    vi.advanceTimersByTime(500)
    edit(b, relabelJA('by B'))
    vi.advanceTimersByTime(GROUP_IDLE_MS - 500)
    // A's group closed first: revision 2 is A's, with T7 changed and JA not.
    const two = getRevision(db, id, 2)!
    expect([two.author, t7(two.board), ja(two.board)]).toEqual(['A', ['K3', 'L3'], fixture().parts.find(p => p.ref === 'JA')!.label])
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    const three = getRevision(db, id, 3)!
    expect([three.author, t7(three.board), ja(three.board)]).toEqual(['B', ['K3', 'L3'], 'by B'])
    expect(listRevisions(db, id)).toHaveLength(3)
  })

  it('composed board that doesn\'t parse commits both as one', () => {
    vi.useFakeTimers()
    const a = connect('a', 'A')
    const b = connect('b', 'B')
    // B widens the board; A draws a trail that only fits the wider board.
    edit(b, x => ({ ...x, board: { ...x.board, cols: 20 } }))
    vi.advanceTimersByTime(500)
    edit(a, x => ({ ...x, trails: [...x.trails, { id: 'T40', side: 'bottom', points: ['A19', 'A20'], joints: [] }] }))
    expect(a.last).toEqual({ ok: true })
    // A's group closes first; head + A's trail alone has a hole off the board.
    leave(a)
    const revs = listRevisions(db, id)
    expect(revs.map(r => [r.n, r.author])).toEqual([[2, 'A, B'], [1, 'Local']])
    expect(getRevision(db, id, 2)!.board.board.cols).toBe(20)
    expect(getRevision(db, id, 2)!.board.trails.some(t => t.id === 'T40')).toBe(true)
    vi.advanceTimersByTime(GROUP_IDLE_MS * 2)
    expect(listRevisions(db, id)).toHaveLength(2)
  })

  it('concurrent create of the same id is rejected', () => {
    const room = openRoom(db, id)!
    const first = detached(room)
    const second = detached(room)
    const addT40 = (to: string) => (x: BoardFile): BoardFile => ({ ...x, trails: [...x.trails, { id: 'T40', side: 'bottom', points: ['A1', to], joints: [] }] })
    const u1 = captured(first, addT40('A2'))
    const u2 = captured(second, addT40('A3'))
    expect(room.receive('p1', 'A', u1)).toEqual({ ok: true })
    expect(room.receive('p2', 'B', u2)).toEqual({ ok: false, reason: 'T40 was just created by someone else; draw it again' })
    expect(boardOf(room.doc).trails.find(t => t.id === 'T40')!.points).toEqual(['A1', 'A2'])

    // Editing an item both had seen is accepted; Yjs picks one of the two (spec §6).
    const third = detached(room)
    const fourth = detached(room)
    expect(room.receive('p3', 'A', captured(third, moveT7('L3')))).toEqual({ ok: true })
    expect(room.receive('p4', 'B', captured(fourth, moveT7('N3')))).toEqual({ ok: true })
    expect([['K3', 'L3'], ['K3', 'N3']]).toContainEqual(t7(boardOf(room.doc)))
    room.dropIfEmpty()
  })

  it('editing an item someone else created, after seeing it, is accepted', () => {
    const a = connect('a', 'A')
    const b = connect('b', 'B')
    edit(a, x => ({ ...x, trails: [...x.trails, { id: 'T40', side: 'bottom', points: ['A1', 'A2'], joints: [] }] }))
    expect(a.last).toEqual({ ok: true })
    edit(b, x => ({ ...x, trails: x.trails.map(t => t.id === 'T40' ? { ...t, points: ['A1', 'A3'] } : t) }))
    expect(b.last).toEqual({ ok: true })
    expect(boardOf(a.doc).trails.find(t => t.id === 'T40')!.points).toEqual(['A1', 'A3'])
    // Deleting it and drawing it again is fine too.
    edit(a, x => ({ ...x, trails: x.trails.filter(t => t.id !== 'T40') }))
    edit(b, x => ({ ...x, trails: [...x.trails, { id: 'T40', side: 'bottom', points: ['A1', 'A4'], joints: [] }] }))
    expect(b.last).toEqual({ ok: true })
  })

  it('restore then a cancelling edit makes no revision', () => {
    vi.useFakeTimers()
    const a = connect('a')
    edit(a, x => ({ ...x, trails: x.trails.filter(t => t.id !== 'T1') }))
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    expect(listRevisions(db, id)).toHaveLength(2)
    // T1 comes back at the end of the doc, not first as in the restored board.
    a.room.serverWrite(getRevision(db, id, 1)!.board, { author: 'Local', how: 'restore', target: 1 })
    expect(listRevisions(db, id)).toHaveLength(3)
    edit(a, moveT7('L3'))
    edit(a, moveT7('M3'))
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    expect(listRevisions(db, id)).toHaveLength(3)
  })

  it('undo command is ordered after the same socket\'s edit', () => {
    const room = openRoom(db, id)!
    const sent: Uint8Array[] = []
    const peer = { id: 'ws1', send: (d: Uint8Array) => sent.push(d) }
    room.join(peer.id, 'A', { update: () => {}, awareness: () => {} })
    const doc = detached(room)
    const update = captured(doc, moveT7('L3'))
    const edits = encoding.createEncoder()
    encoding.writeVarUint(edits, 0)
    syncProtocol.writeUpdate(edits, update)
    const command = (op: string, n: number) => {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, MESSAGE_COMMAND)
      encoding.writeVarString(e, JSON.stringify({ op, id: n }))
      return encoding.toUint8Array(e)
    }
    expect(handleMessage(peer, room, 'A', encoding.toUint8Array(edits))).toEqual({ ok: true })
    expect(handleMessage(peer, room, 'A', command('undo', 7))).toEqual({ ok: true })
    const replies = sent.map((d) => {
      const dec = decoding.createDecoder(d)
      return [decoding.readVarUint(dec), JSON.parse(decoding.readVarString(dec))]
    })
    expect(replies).toEqual([[MESSAGE_COMMAND, { id: 7, ok: true }]])
    expect(listRevisions(db, id).map(r => [r.n, r.how, r.author, r.target])).toEqual([[3, 'undo', 'A', 2], [2, 'edit', 'A', null], [1, 'create', 'Local', null]])
    expect(t7(boardOf(room.doc))).toEqual(['K3', 'M3'])

    sent.length = 0
    handleMessage(peer, room, 'A', command('undo', 8))
    handleMessage(peer, room, 'A', command('undo', 9))
    expect(sent.map(d => JSON.parse(decoding.readVarString((() => {
      const dec = decoding.createDecoder(d)
      decoding.readVarUint(dec)
      return dec
    })())))).toEqual([{ id: 8, ok: false, reason: 'nothing to undo' }, { id: 9, ok: false, reason: 'nothing to undo' }])
    expect(handleMessage(peer, room, 'A', command('explode', 10)).ok).toBe(false)
    room.leave(peer.id)
  })
})

function relabelJA(label: string) {
  return (b: BoardFile): BoardFile => ({ ...b, parts: b.parts.map(p => p.ref === 'JA' ? { ...p, label } : p) })
}

const ja = (b: BoardFile) => b.parts.find(p => p.ref === 'JA')!.label

/** A doc with the room's state that is not joined: its edits reach the room only when passed to `receive`. */
function detached(room: Room): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc))
  return doc
}

/** The update one editor transaction on `doc` produces. */
function captured(doc: Y.Doc, change: (b: BoardFile) => BoardFile): Uint8Array {
  let update: Uint8Array | null = null
  const grab = (u: Uint8Array) => {
    update = u
  }
  doc.on('update', grab)
  const before = boardOf(doc)
  writeBoard(doc, before, change(structuredClone(before)))
  doc.off('update', grab)
  return update!
}
