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
import { eq } from 'drizzle-orm'
import { revisions } from '../../server/db/schema'
import { createBoard, getBoard, getRevision, listRevisions } from '../../server/utils/boards'
import { GROUP_IDLE_MS, openRoom, type Room } from '../../server/utils/rooms'
import { handleMessage } from '../../server/utils/liveMessage'
import { MESSAGE_COMMAND } from '../../shared/liveCommand'
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

function connect(peerId: string, author = 'Local', authorId: string | null = null, presence?: { name: string, avatar?: string }): Client {
  const room = openRoom(db, id)!
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const client: Client = { peerId, author, doc, awareness, room, last: null, left: false }
  room.join(peerId, author, {
    update: u => Y.applyUpdate(doc, u, 'remote'),
    awareness: u => applyAwarenessUpdate(awareness, u, 'remote')
  }, { role: 'owner', viaLink: false, authorId, presence })
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
  id = createBoard(db, fixture(), 'create', 'Local', 'local').id
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

  it('an anonymous peer that claims a name reaches the others as Guest', () => {
    const guest = connect('g', 'Visitor', null, { name: 'Guest' })
    const b = connect('b')
    guest.awareness.setLocalState({ user: { name: 'Ada', color: '#123456', avatar: 'https://avatars.githubusercontent.com/u/1' } })
    guest.room.receiveAwareness('g', encodeAwarenessUpdate(guest.awareness, [guest.doc.clientID]))
    expect(b.awareness.getStates().get(guest.doc.clientID)).toEqual({ user: { name: 'Guest', color: '#123456' } })
    // Under another client's id too: still the sender's own stamp.
    const forged = new Awareness(new Y.Doc())
    forged.setLocalState({ user: { name: 'Ada' } })
    guest.room.receiveAwareness('g', encodeAwarenessUpdate(forged, [forged.clientID]))
    expect(b.awareness.getStates().get(forged.clientID)).toEqual({ user: { name: 'Guest' } })
    // A peer joining later is sent the stamped state.
    expect(connect('c').awareness.getStates().get(guest.doc.clientID)).toEqual({ user: { name: 'Guest', color: '#123456' } })
  })

  it('a client another peer updates goes with that peer when it leaves', () => {
    const a = connect('a')
    const g = connect('g', 'Visitor', null, { name: 'Guest' })
    const c = connect('c')
    a.awareness.setLocalState({ user: { name: 'Local · Tablet' } })
    a.room.receiveAwareness('a', encodeAwarenessUpdate(a.awareness, [a.doc.clientID]))
    // g sends a newer state under a's client id: an update, not an add.
    const forged = new Awareness(new Y.Doc())
    forged.clientID = a.doc.clientID
    // A higher clock than a's own state, so the room takes it.
    for (let i = 0; i < 5; i++) forged.setLocalState({ user: { name: 'Ada' } })
    g.room.receiveAwareness('g', encodeAwarenessUpdate(forged, [a.doc.clientID]))
    expect(c.awareness.getStates().get(a.doc.clientID)).toEqual({ user: { name: 'Guest' } })
    leave(g)
    expect(c.awareness.getStates().has(a.doc.clientID)).toBe(false)
  })

  it('a signed-in peer that claims another name arrives under its account name and avatar', () => {
    const bob = connect('bob', 'Bob', 'u-bob', { name: 'Bob', avatar: 'https://avatars.githubusercontent.com/u/2' })
    const b = connect('b')
    bob.awareness.setLocalState({ user: { name: 'Ada', color: '#654321', avatar: 'https://avatars.githubusercontent.com/u/1' } })
    bob.room.receiveAwareness('bob', encodeAwarenessUpdate(bob.awareness, [bob.doc.clientID]))
    expect(b.awareness.getStates().get(bob.doc.clientID)).toEqual({ user: { name: 'Bob', color: '#654321', avatar: 'https://avatars.githubusercontent.com/u/2' } })
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

  it('live edits store their author\'s id; a revision of several authors stores none', () => {
    vi.useFakeTimers()
    const authorIds = () => db.select({ n: revisions.n, authorId: revisions.authorId }).from(revisions).where(eq(revisions.boardId, id)).orderBy(revisions.n).all().map(r => [r.n, r.authorId])
    const a = connect('a', 'A', 'user-a')
    edit(a, moveT7('L3'))
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    expect(authorIds()).toEqual([[1, null], [2, 'user-a']])
    // An undo from the socket is the peer's.
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, MESSAGE_COMMAND)
    encoding.writeVarString(e, JSON.stringify({ op: 'undo', id: 1 }))
    expect(handleMessage({ id: 'a', send: () => {} }, a.room, 'A', encoding.toUint8Array(e))).toEqual({ ok: true })
    expect(authorIds().at(-1)).toEqual([3, 'user-a'])

    const b = connect('b', 'B', 'user-b')
    edit(b, x => ({ ...x, board: { ...x.board, cols: 20 } }))
    vi.advanceTimersByTime(500)
    edit(a, x => ({ ...x, trails: [...x.trails, { id: 'T40', side: 'bottom', points: ['A19', 'A20'], joints: [] }] }))
    leave(a)
    expect(listRevisions(db, id)[0]!.author).toBe('A, B')
    expect(authorIds().at(-1)).toEqual([4, null])
  })

  it('two accounts with the same name never share a revision under one id', () => {
    vi.useFakeTimers()
    const rows = () => db.select({ n: revisions.n, author: revisions.author, authorId: revisions.authorId, board: revisions.board })
      .from(revisions).where(eq(revisions.boardId, id)).orderBy(revisions.n).all()
    const a = connect('a', 'Ada', 'user-a')
    const b = connect('b', 'Ada', 'user-b')
    edit(a, moveT7('L3'))
    edit(b, relabelJA('by the other Ada'))
    vi.advanceTimersByTime(GROUP_IDLE_MS)
    // Each account's edit is its own revision, under its own id; the second builds on the first.
    expect(rows().map((r) => {
      const board = JSON.parse(r.board) as BoardFile
      return [r.n, r.author, r.authorId, t7(board)[1], ja(board)]
    })).toEqual([
      [1, 'Local', null, 'M3', ja(fixture())],
      [2, 'Ada', 'user-a', 'L3', ja(fixture())],
      [3, 'Ada', 'user-b', 'L3', 'by the other Ada']
    ])
  })

  it('a revision combining two accounts of the same name stores no id', () => {
    vi.useFakeTimers()
    const a = connect('a', 'Ada', 'user-a')
    const b = connect('b', 'Ada', 'user-b')
    // B widens the board; A draws a trail that only fits the wider board.
    edit(b, x => ({ ...x, board: { ...x.board, cols: 20 } }))
    vi.advanceTimersByTime(500)
    edit(a, x => ({ ...x, trails: [...x.trails, { id: 'T40', side: 'bottom', points: ['A19', 'A20'], joints: [] }] }))
    leave(a)
    const head = db.select({ n: revisions.n, author: revisions.author, authorId: revisions.authorId }).from(revisions)
      .where(eq(revisions.boardId, id)).orderBy(revisions.n).all().at(-1)
    expect(head).toEqual({ n: 2, author: 'Ada, Ada', authorId: null })
    leave(b)
  })

  it('concurrent create of the same id is rejected', () => {
    const room = openRoom(db, id)!
    // Only peers in the room may send to it.
    for (const p of ['p1', 'p2', 'p3', 'p4']) room.join(p, p, { update: () => {}, awareness: () => {} })
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
    for (const p of ['p1', 'p2', 'p3', 'p4']) room.leave(p)
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

  it('a server fault in undo is answered, not a closed socket', () => {
    const room = openRoom(db, id)!
    const sent: Uint8Array[] = []
    const peer = { id: 'ws1', send: (d: Uint8Array) => sent.push(d) }
    room.join(peer.id, 'A', { update: () => {}, awareness: () => {} })
    vi.spyOn(room, 'undo').mockImplementation(() => {
      throw new Error('disk full')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, MESSAGE_COMMAND)
    encoding.writeVarString(e, JSON.stringify({ op: 'undo', id: 4 }))
    expect(handleMessage(peer, room, 'A', encoding.toUint8Array(e))).toEqual({ ok: true })
    const dec = decoding.createDecoder(sent[0]!)
    expect(decoding.readVarUint(dec)).toBe(MESSAGE_COMMAND)
    expect(JSON.parse(decoding.readVarString(dec))).toEqual({ id: 4, ok: false, reason: 'undo failed on the server' })
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
    room.leave(peer.id)
  })

  it('view peer\'s update closes it with 4403', () => {
    const room = openRoom(db, id)!
    const sent: Uint8Array[] = []
    const viewer = { id: 'v1', send: (d: Uint8Array) => sent.push(d) }
    const editor = { id: 'e1', send: () => {} }
    room.join(viewer.id, 'Visitor', { update: () => {}, awareness: () => {} }, { role: 'view', viaLink: true })
    room.join(editor.id, 'Bob', { update: () => {}, awareness: () => {} }, { role: 'edit', viaLink: true })
    expect(room.peerAccess(viewer.id)).toEqual({ role: 'view', viaLink: true })
    expect(room.peerAccess(editor.id)).toEqual({ role: 'edit', viaLink: true })
    expect(room.peerAccess('nobody')).toBeNull()

    const sync = (step: 'update' | 'step2', update: Uint8Array) => {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 0)
      encoding.writeVarUint(e, step === 'update' ? syncProtocol.messageYjsUpdate : syncProtocol.messageYjsSyncStep2)
      encoding.writeVarUint8Array(e, update)
      return encoding.toUint8Array(e)
    }
    const VIEW_ONLY = { ok: false, reason: 'view only', code: 4403 }

    // A viewer's own sync step 2 changes nothing: it is accepted, so a viewer can connect.
    const doc = detached(room)
    expect(handleMessage(viewer, room, 'Visitor', sync('step2', Y.encodeStateAsUpdate(doc, Y.encodeStateVector(room.doc))))).toEqual({ ok: true })
    // An update that changes the board is refused, and the board is untouched.
    expect(handleMessage(viewer, room, 'Visitor', sync('update', captured(doc, moveT7('L3'))))).toEqual(VIEW_ONLY)
    expect(t7(boardOf(room.doc))).toEqual(['K3', 'M3'])
    // So is a command, before it runs.
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, MESSAGE_COMMAND)
    encoding.writeVarString(e, JSON.stringify({ op: 'undo', id: 1 }))
    expect(handleMessage(viewer, room, 'Visitor', encoding.toUint8Array(e))).toEqual(VIEW_ONLY)
    expect(sent).toEqual([])
    expect(listRevisions(db, id)).toHaveLength(1)

    // An editor's same update is accepted.
    expect(handleMessage(editor, room, 'Bob', sync('update', captured(detached(room), moveT7('L3'))))).toEqual({ ok: true })
    expect(t7(boardOf(room.doc))).toEqual(['K3', 'L3'])
    room.leave(viewer.id)
    room.leave(editor.id)
  })

  it('edit-link live update can\'t rename; the same peer\'s other edits still work, and the owner renames', () => {
    const room = openRoom(db, id)!
    room.join('e1', 'Bob', { update: () => {}, awareness: () => {} }, { role: 'edit', viaLink: true })
    room.join('o1', 'Ada', { update: () => {}, awareness: () => {} }, { role: 'owner', viaLink: false })
    const name = fixture().name
    const refused = room.receive('e1', 'Bob', captured(detached(room), b => ({ ...b, name: 'Renamed by Bob' })))
    expect(refused).toEqual({ ok: false, reason: 'Only the owner can rename the board.' })
    expect(boardOf(room.doc).name).toBe(name)
    // A rename hidden in a bigger edit is refused whole.
    expect(room.receive('e1', 'Bob', captured(detached(room), b => ({ ...moveT7('L3')(b), name: 'Sneaky' }))).ok).toBe(false)
    expect(t7(boardOf(room.doc))).toEqual(['K3', 'M3'])
    // The editor's next, ordinary edit is accepted.
    expect(room.receive('e1', 'Bob', captured(detached(room), moveT7('L3')))).toEqual({ ok: true })
    expect(t7(boardOf(room.doc))).toEqual(['K3', 'L3'])
    // The owner renames live; the editor's edits after that keep the new name.
    expect(room.receive('o1', 'Ada', captured(detached(room), b => ({ ...b, name: 'By Ada' })))).toEqual({ ok: true })
    expect(room.receive('e1', 'Bob', captured(detached(room), moveT7('M3')))).toEqual({ ok: true })
    expect(getBoard(db, id)!.board.name).toBe('By Ada')
    room.leave('e1')
    room.leave('o1')
  })

  it('a peer joined without access is the owner (step 1 callers)', () => {
    const room = openRoom(db, id)!
    room.join('o', 'Local', { update: () => {}, awareness: () => {} })
    expect(room.peerAccess('o')).toEqual({ role: 'owner', viaLink: false })
    room.leave('o')
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
