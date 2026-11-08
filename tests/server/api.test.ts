import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { parseBoard, type BoardFile } from '../../core/schema'
import { eq } from 'drizzle-orm'
import { openDb, type Db } from '../../server/db'
import { boards, linkVisits, revisions } from '../../server/db/schema'
import { unlockEntry } from '../../server/utils/boardAccess'
import { signIn } from '../../server/utils/accounts'
import * as api from '../../server/utils/api'
import { MAX_BOARD_BYTES } from '../../server/utils/api'
import { getBoard, getBoardRow, listBoards, listRevisions } from '../../server/utils/boards'
import { openRoom } from '../../server/utils/rooms'
import type { Who } from '../../server/utils/who'
import { docToBoard, writeBoard } from '../../shared/yboard'

let dir: string
let db: Db
const text = readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')
const fixture = JSON.parse(text) as BoardFile

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-api-'))
  db = openDb(dir)
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

/** The local user asking by board id, as every step 1 caller did. */
const own = (key: string, author = 'Local'): api.BoardRequest => ({ key, who: { kind: 'local', userId: 'local', author } })

function importFixture(): string {
  const r = api.createOrImport(db, JSON.stringify({ board: fixture }))
  expect(r.status).toBe(200)
  return (r.body as { id: string }).id
}

describe('create and import', () => {
  it('import then get returns the board with head 1', () => {
    const id = importFixture()
    const r = api.getBoardResponse(db, own(id))
    expect(r.status).toBe(200)
    const body = r.body as { id: string, name: string, head: number, board: BoardFile }
    expect(body).toMatchObject({ id, name: 'Channel board 2', head: 1 })
    expect(body.board.revision).toBe(1)
    expect(body.board.parts).toEqual(fixture.parts)
  })

  it('creates an empty board that parses', () => {
    const r = api.createOrImport(db, JSON.stringify({ name: 'Blank', cols: 10, rows: 8, type: 'two-sided' }))
    expect(r.status).toBe(200)
    const id = (r.body as { id: string }).id
    const got = api.getBoardResponse(db, own(id)).body as { board: BoardFile }
    expect(got.board).toMatchObject({ name: 'Blank', board: { cols: 10, rows: 8, pitchMm: 2.54, type: 'two-sided' }, parts: [] })
    expect(parseBoard(got.board).ok).toBe(true)
    expect(listRevisions(db, id)[0]).toMatchObject({ how: 'create', author: 'Local' })
  })

  it('rejects a bad create with 422', () => {
    for (const body of [{ name: '', cols: 4, rows: 4, type: 'one-sided' }, { name: 'x', cols: 0, rows: 4, type: 'one-sided' }, { name: 'x', cols: 4, rows: 4, type: 'round' }, {}]) {
      const r = api.createOrImport(db, JSON.stringify(body))
      expect(r.status).toBe(422)
      expect((r.body as { errors: string[] }).errors.length).toBeGreaterThan(0)
    }
    expect(listBoards(db, 'local', 'mine')).toEqual([])
  })

  it('bad import creates nothing', () => {
    expect(api.createOrImport(db, '{ nope').status).toBe(422)
    const schema = api.createOrImport(db, JSON.stringify({ board: { name: 'x' } }))
    expect(schema.status).toBe(422)
    expect((schema.body as { errors: string[] }).errors.length).toBeGreaterThan(0)
    expect(api.createOrImport(db, 'x'.repeat(MAX_BOARD_BYTES + 1)).status).toBe(413)
    expect(listBoards(db, 'local', 'mine')).toEqual([])
  })
})

describe('put', () => {
  it('with a stale baseRevision is 409 and changes nothing', () => {
    const id = importFixture()
    const r = api.putBoard(db, own(id), JSON.stringify({ board: { ...fixture, name: 'Other' }, baseRevision: 0 }))
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ current: 1 })
    expect(listRevisions(db, id)).toHaveLength(1)
    expect((api.getBoardResponse(db, own(id)).body as { name: string }).name).toBe('Channel board 2')
  })

  it('with a stale baseRevision on a room with no peers drops the room', () => {
    const id = importFixture()
    const room = openRoom(db, id)!
    expect(api.putBoard(db, own(id), JSON.stringify({ board: fixture, baseRevision: 0 })).status).toBe(409)
    expect(openRoom(db, id)).not.toBe(room)
    openRoom(db, id)!.leave('nobody')
  })

  it('PUT with base = head during an open group is 409, and the tablet edit survives', () => {
    vi.useFakeTimers()
    try {
      const id = importFixture()
      const claudeView = getBoard(db, id)!
      const room = openRoom(db, id)!
      const doc = new Y.Doc()
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc), 'remote')
      room.join('tablet', 'Tablet', { update: u => Y.applyUpdate(doc, u, 'remote'), awareness: () => {} })
      doc.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin !== 'remote') expect(room.receive('tablet', 'Tablet', u)).toEqual({ ok: true })
      })
      const before = docToBoard(doc, 0)
      if (!before.ok) throw new Error(before.errors.join())
      writeBoard(doc, before.board, { ...before.board, name: 'tablet rename' })

      const r = api.putBoard(db, own(id, 'Claude'), JSON.stringify({ board: claudeView.board, baseRevision: claudeView.head }))
      expect(r).toEqual({ status: 409, body: { current: 2 } })
      expect(getBoard(db, id)!.board.name).toBe('tablet rename')
      expect(listRevisions(db, id).map(x => [x.n, x.how, x.author])).toEqual([[2, 'edit', 'Tablet'], [1, 'import', 'Local']])
      expect(api.putBoard(db, own(id, 'Claude'), JSON.stringify({ board: { ...claudeView.board, name: 'Claude' }, baseRevision: 2 })).status).toBe(200)
      room.leave('tablet')
      doc.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('without baseRevision writes a revision how api', () => {
    const id = importFixture()
    const r = api.putBoard(db, own(id), JSON.stringify({ board: { ...fixture, name: 'Other' } }))
    expect(r).toEqual({ status: 200, body: { revision: 2 } })
    expect(listRevisions(db, id)[0]).toMatchObject({ n: 2, how: 'api', author: 'Local' })
    expect(api.putBoard(db, own(id), JSON.stringify({ board: fixture, baseRevision: 2 })).status).toBe(200)
  })

  it('is 422 for an invalid board and 404 for an unknown one', () => {
    const id = importFixture()
    expect(api.putBoard(db, own(id), JSON.stringify({ board: { name: 'x' } })).status).toBe(422)
    expect(api.putBoard(db, own(id), JSON.stringify({ board: fixture, baseRevision: 'one' })).status).toBe(422)
    expect(api.putBoard(db, own('nope'), JSON.stringify({ board: fixture })).status).toBe(404)
    expect(api.putBoard(db, own(id), 'x'.repeat(MAX_BOARD_BYTES + 1)).status).toBe(413)
    expect(listRevisions(db, id)).toHaveLength(1)
  })
})

describe('rename', () => {
  it('is a board change by Local through the API', () => {
    const id = importFixture()
    expect(api.renameBoard(db, own(id), JSON.stringify({ name: '  New name ' })).body).toEqual({ revision: 2 })
    expect((api.getBoardResponse(db, own(id)).body as { name: string }).name).toBe('New name')
    expect(listRevisions(db, id)[0]).toMatchObject({ how: 'api', author: 'Local' })
    expect(api.renameBoard(db, own(id), JSON.stringify({ name: '   ' })).status).toBe(422)
    expect(api.renameBoard(db, own(id), JSON.stringify({ name: 3 })).status).toBe(422)
    expect(api.renameBoard(db, own('nope'), JSON.stringify({ name: 'a' })).status).toBe(404)
  })
})

describe('revisions, restore, undo, redo', () => {
  it('lists revisions and returns one board', () => {
    const id = importFixture()
    api.putBoard(db, own(id), JSON.stringify({ board: { ...fixture, name: 'B' } }))
    const list = api.listRevisionsResponse(db, own(id)).body as { n: number }[]
    expect(list.map(r => r.n)).toEqual([2, 1])
    expect((api.getRevisionResponse(db, own(id), '1').body as BoardFile).name).toBe('Channel board 2')
    expect(api.getRevisionResponse(db, own(id), '9').status).toBe(404)
    expect(api.getRevisionResponse(db, own(id), 'abc').status).toBe(404)
  })

  it('restore makes revision n the current board as a new revision', () => {
    const id = importFixture()
    api.putBoard(db, own(id), JSON.stringify({ board: { ...fixture, name: 'B' } }))
    const r = api.restoreRevision(db, own(id), '1')
    expect(r).toEqual({ status: 200, body: { revision: 3 } })
    const got = api.getBoardResponse(db, own(id)).body as { name: string, head: number }
    expect(got).toMatchObject({ name: 'Channel board 2', head: 3 })
    expect(listRevisions(db, id)[0]).toMatchObject({ n: 3, how: 'restore', target: 1 })
    expect(api.restoreRevision(db, own(id), '9').status).toBe(404)
  })

  it('undo with nothing to undo is 409; undo and redo otherwise', () => {
    const id = importFixture()
    expect(api.undoBoard(db, own(id))).toEqual({ status: 409, body: { reason: 'nothing to undo' } })
    expect(api.redoBoard(db, own(id))).toEqual({ status: 409, body: { reason: 'nothing to redo' } })
    api.putBoard(db, own(id), JSON.stringify({ board: { ...fixture, name: 'B' } }))
    expect(api.undoBoard(db, own(id))).toEqual({ status: 200, body: { revision: 3 } })
    expect((api.getBoardResponse(db, own(id)).body as { name: string }).name).toBe('Channel board 2')
    expect(api.redoBoard(db, own(id))).toEqual({ status: 200, body: { revision: 4 } })
    expect((api.getBoardResponse(db, own(id)).body as { name: string }).name).toBe('B')
    expect(api.undoBoard(db, own('nope')).status).toBe(404)
  })
})

describe('check, bench, download', () => {
  it('check returns findings, stats and the stats line', () => {
    const id = importFixture()
    const r = api.checkBoard(db, own(id))
    expect(r.status).toBe(200)
    const body = r.body as { findings: unknown[], stats: { errors: number }, statsLine: string, advisory: string }
    expect(Array.isArray(body.findings)).toBe(true)
    expect(body.statsLine).toMatch(/^\d+ nets?, \d+ groups?: \d+ errors?/)
    expect(body.advisory).toBe('Advisory only. Check the board with a meter before powering it.')
    expect(api.checkBoard(db, own('nope')).status).toBe(404)
  })

  it('bench returns HTML containing the board name, keyed by id and head', () => {
    const id = importFixture()
    const r = api.benchBoard(db, own(id), '2026-11-06')
    expect(r.status).toBe(200)
    expect(r.headers?.['content-type']).toBe('text/html; charset=utf-8')
    expect(r.headers?.['content-disposition']).toBe('inline; filename="Channel-board-2.bench.html"')
    expect(r.body as string).toContain('Channel board 2')
    expect(r.body as string).toMatch(/wirebender:Channel board 2:[0-9a-f]{12}/)
    api.putBoard(db, own(id), JSON.stringify({ board: fixture }))
    const again = api.benchBoard(db, own(id), '2026-11-06').body as string
    expect(again).not.toBe(r.body)
    expect(api.benchBoard(db, own('nope')).status).toBe(404)
  })

  it('download sets the filename and returns a board that parses', () => {
    const id = importFixture()
    const r = api.downloadBoard(db, own(id))
    expect(r.status).toBe(200)
    expect(r.headers?.['content-disposition']).toBe('attachment; filename="Channel-board-2.wirebender.json"')
    expect(parseBoard(JSON.parse(r.body as string)).ok).toBe(true)
    expect(api.downloadBoard(db, own('nope')).status).toBe(404)
  })
})

describe('access by key and role', () => {
  function user(name: string): Who & { kind: 'user' } {
    const r = signIn(db, 'github', { id: `gh-${name}`, name })
    if (!r.ok) throw new Error('sign-in failed')
    return { kind: 'user', userId: r.userId, author: name, isAdmin: false, isPremium: false }
  }
  const ANON: Who = { kind: 'anonymous' }

  /** A board Ada imported, with one more revision so undo, redo and restore have something to do. */
  function adaBoard(set: Partial<typeof boards.$inferInsert> = {}): { id: string, linkId: string, owner: Who & { kind: 'user' } } {
    const owner = user('Ada')
    const r = api.createOrImport(db, JSON.stringify({ board: fixture }), 'Ada', owner.userId)
    const id = (r.body as { id: string }).id
    expect(api.putBoard(db, { key: id, who: owner }, JSON.stringify({ board: { ...fixture, name: 'B' } })).status).toBe(200)
    if (Object.keys(set).length > 0) db.update(boards).set(set).where(eq(boards.id, id)).run()
    return { id, linkId: getBoardRow(db, id)!.linkId, owner }
  }

  /** Every board route, as one call each. */
  const routes = (req: api.BoardRequest): Record<string, () => api.ApiResult> => ({
    get: () => api.getBoardResponse(db, req),
    put: () => api.putBoard(db, req, JSON.stringify({ board: fixture })),
    patch: () => api.renameBoard(db, req, JSON.stringify({ name: 'X' })),
    check: () => api.checkBoard(db, req),
    bench: () => api.benchBoard(db, req, '2026-11-07'),
    download: () => api.downloadBoard(db, req),
    revisions: () => api.listRevisionsResponse(db, req),
    revision: () => api.getRevisionResponse(db, req, '1'),
    restore: () => api.restoreRevision(db, req, '1'),
    undo: () => api.undoBoard(db, req),
    redo: () => api.redoBoard(db, req)
  })

  it('board id is 404 for non-owners', () => {
    const b = adaBoard({ visibility: 'edit' })
    const unknown = routes({ key: 'no-such-board', who: user('Bob') })
    for (const who of [user('Bob'), ANON, { kind: 'local', userId: 'local', author: 'Local' } as Who]) {
      for (const [name, call] of Object.entries(routes({ key: b.id, who }))) {
        const r = call()
        expect(r, name).toEqual(unknown[name]!())
        expect(r, name).toEqual({ status: 404, body: { error: 'not found' } })
      }
    }
    expect(listRevisions(db, b.id)).toHaveLength(2)
    expect(api.getBoardResponse(db, { key: b.id, who: b.owner })).toMatchObject({ status: 200, body: { id: b.id, role: 'owner', signInToEdit: false, owner: { name: 'Ada' } } })
  })

  it('link responses carry the link id only', () => {
    const b = adaBoard({ visibility: 'edit', forkedFrom: 'the-original-board' })
    const req = { key: b.linkId, who: user('Bob') }
    expect(api.getBoardResponse(db, req)).toMatchObject({ status: 200, body: { id: b.linkId, name: 'B', role: 'edit', signInToEdit: false, owner: { name: 'Ada' } } })
    for (const [name, call] of Object.entries(routes(req))) {
      if (name === 'patch') continue
      const r = call()
      expect(r.status, name).toBe(200)
      const json = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
      expect(json, name).not.toContain(b.id)
      expect(json, name).not.toContain('the-original-board')
    }
  })

  it('anonymous on an edit link can read but PUT is 403 Sign in to edit.', () => {
    const b = adaBoard({ visibility: 'edit' })
    const req = { key: b.linkId, who: ANON }
    expect(api.getBoardResponse(db, req)).toMatchObject({ status: 200, body: { id: b.linkId, role: 'view', signInToEdit: true } })
    const r = routes(req)
    for (const name of ['check', 'bench', 'download', 'revisions', 'revision']) expect(r[name]!().status, name).toBe(200)
    for (const name of ['put', 'restore', 'undo', 'redo']) expect(r[name]!(), name).toEqual({ status: 403, body: { error: 'Sign in to edit.' } })
    expect(r.patch!()).toEqual({ status: 404, body: { error: 'not found' } })
    expect(listRevisions(db, b.id)).toHaveLength(2)
  })

  it('a view link reads only; an edit link writes under the visitor\'s name; rename is the owner\'s', () => {
    const b = adaBoard()
    const bob = user('Bob')
    const view = routes({ key: b.linkId, who: bob })
    expect(view.get!()).toMatchObject({ body: { role: 'view', signInToEdit: false } })
    for (const name of ['put', 'patch', 'restore', 'undo', 'redo']) expect(view[name]!(), name).toEqual({ status: 404, body: { error: 'not found' } })
    for (const name of ['get', 'check', 'download', 'revisions', 'revision']) expect(view[name]!().status, name).toBe(200)

    db.update(boards).set({ visibility: 'edit' }).where(eq(boards.id, b.id)).run()
    const edit = routes({ key: b.linkId, who: bob })
    expect(edit.put!()).toEqual({ status: 200, body: { revision: 3 } })
    expect(listRevisions(db, b.id)[0]).toMatchObject({ n: 3, author: 'Bob', how: 'api' })
    expect(edit.patch!()).toEqual({ status: 404, body: { error: 'not found' } })
    expect(api.renameBoard(db, { key: b.linkId, who: b.owner }, JSON.stringify({ name: 'X' })).status).toBe(404)
    expect(api.renameBoard(db, { key: b.id, who: b.owner }, JSON.stringify({ name: 'X' })).status).toBe(200)
  })

  it('password link needs unlock, then opens', () => {
    const b = adaBoard({ passwordHash: 'h:secret' })
    const bob = user('Bob')
    for (const [name, call] of Object.entries(routes({ key: b.linkId, who: bob }))) {
      // Rename is owner-only: every refusal there is the plain 404.
      expect(call(), name).toEqual(name === 'patch' ? { status: 404, body: { error: 'not found' } } : { status: 401, body: { password: true } })
    }
    expect(api.getBoardResponse(db, { key: b.linkId, who: bob, unlocked: [unlockEntry(b.linkId, 'h:secret')] })).toMatchObject({ status: 200, body: { id: b.linkId } })
    // The owner by board id never needs it.
    expect(api.getBoardResponse(db, { key: b.id, who: b.owner }).status).toBe(200)
  })

  it('private link is 404 even for the owner by link', () => {
    const b = adaBoard({ visibility: 'private' })
    expect(api.getBoardResponse(db, { key: b.linkId, who: b.owner })).toEqual({ status: 404, body: { error: 'not found' } })
  })

  it('trashed board is 404 by link', () => {
    const b = adaBoard({ trashedAt: Date.now() })
    expect(api.getBoardResponse(db, { key: b.linkId, who: user('Bob') })).toEqual({ status: 404, body: { error: 'not found' } })
    expect(api.getBoardResponse(db, { key: b.id, who: b.owner }).status).toBe(200)
  })

  it('a signed-in non-owner who opens a board by link gets a link_visits row', () => {
    const b = adaBoard()
    const bob = user('Bob')
    vi.useFakeTimers({ now: 1000 })
    try {
      api.getBoardResponse(db, { key: b.linkId, who: bob })
      vi.setSystemTime(5000)
      api.getBoardResponse(db, { key: b.linkId, who: bob })
      api.getBoardResponse(db, { key: b.linkId, who: b.owner })
      api.getBoardResponse(db, { key: b.linkId, who: ANON })
      api.getBoardResponse(db, { key: b.id, who: b.owner })
    } finally {
      vi.useRealTimers()
    }
    expect(db.select().from(linkVisits).all()).toEqual([{ userId: bob.userId, boardId: b.id, linkId: b.linkId, lastOpened: 5000 }])
  })

  it('a revision written by a signed-in user stores their id', () => {
    const b = adaBoard({ visibility: 'edit' })
    const bob = user('Bob')
    const ids = () => db.select({ n: revisions.n, how: revisions.how, authorId: revisions.authorId }).from(revisions)
      .where(eq(revisions.boardId, b.id)).orderBy(revisions.n).all().map(r => [r.n, r.how, r.authorId])
    const req = { key: b.linkId, who: bob }
    expect(api.putBoard(db, req, JSON.stringify({ board: { ...fixture, name: 'Bob' } })).status).toBe(200)
    expect(api.undoBoard(db, req).status).toBe(200)
    expect(api.redoBoard(db, req).status).toBe(200)
    expect(api.restoreRevision(db, req, '1').status).toBe(200)
    expect(api.renameBoard(db, { key: b.id, who: b.owner }, JSON.stringify({ name: 'Z' })).status).toBe(200)
    expect(ids()).toEqual([
      [1, 'import', b.owner.userId], [2, 'api', b.owner.userId], [3, 'api', bob.userId],
      [4, 'undo', bob.userId], [5, 'redo', bob.userId], [6, 'restore', bob.userId], [7, 'api', b.owner.userId]
    ])
    // The local user's are 'local'.
    const local = importFixture()
    api.putBoard(db, own(local), JSON.stringify({ board: fixture }))
    expect(db.select({ authorId: revisions.authorId }).from(revisions).where(eq(revisions.boardId, local)).all()).toEqual([{ authorId: 'local' }, { authorId: 'local' }])
  })

  it('the bench tick key does not tie a link to the board id', () => {
    const b = adaBoard()
    const key = (r: api.ApiResult) => /wirebender:B:([0-9a-f]{12})/.exec(r.body as string)![1]
    const byId = key(api.benchBoard(db, { key: b.id, who: b.owner }, '2026-11-07'))
    const byLink = key(api.benchBoard(db, { key: b.linkId, who: user('Bob') }, '2026-11-07'))
    expect(byLink).not.toBe(byId)
    expect(key(api.benchBoard(db, { key: b.id, who: b.owner }, '2026-11-07'))).toBe(byId)
  })

  it('boards are created and listed for who asks', () => {
    const owner = user('Ada')
    const r = api.createOrImport(db, JSON.stringify({ board: fixture }), 'Ada', owner.userId)
    const id = (r.body as { id: string }).id
    expect(getBoardRow(db, id)!.ownerId).toBe(owner.userId)
    expect((api.listBoardsResponse(db, owner.userId).body as { id: string }[]).map(x => x.id)).toEqual([id])
    expect(api.listBoardsResponse(db, 'local').body).toEqual([])
  })
})
