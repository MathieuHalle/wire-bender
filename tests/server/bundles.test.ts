// Board bundles on the server: export, import, download-all and the admin export.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUNDLE_FORMAT, MAX_BUNDLE_BYTES, encodeBundle, type Bundle } from '../../core/bundle'
import type { BoardFile } from '../../core/schema'
import { openDb, type Db } from '../../server/db'
import { boards, revisions, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { exportAll, exportBundle, exportServer, exportServerResult, importBundle } from '../../server/utils/bundles'
import { tokenRefusal } from '../../server/utils/access'
import { commitRevision, createBoard, listBoards, listRevisions } from '../../server/utils/boards'
import { openRoom } from '../../server/utils/rooms'
import type { Who } from '../../server/utils/who'

const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
const MIGRATIONS = path.resolve(__dirname, '../../server/db/migrations')

let dir: string
let db: Db
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-bundles-'))
  db = openDb(dir)
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

const local: Who = { kind: 'local', userId: 'local', author: 'Local' }
const named = (board: BoardFile, name: string): BoardFile => ({ ...board, name })

function account(name: string, admin = false): Who & { kind: 'user' } {
  const r = signIn(db, 'github', { id: `gh-${name}`, name })
  if (!r.ok) throw new Error('sign-in failed')
  if (admin) db.update(users).set({ isAdmin: 1 }).where(eq(users.id, r.userId)).run()
  return { kind: 'user', userId: r.userId, author: name, isAdmin: admin, isPremium: false }
}

const bytesOf = (r: { body: unknown }) => r.body as Uint8Array
const files = (zip: Uint8Array) => unzipSync(zip)

/** A board with an edit by Bob and an undo of it by Cy, each with its own author. */
function historyBoard(ownerId = 'local') {
  const { id } = createBoard(db, named(fixture, 'Amp'), 'create', 'Ann', ownerId, ownerId)
  commitRevision(db, id, { board: named(fixture, 'Amp 2'), author: 'Bob', how: 'edit' })
  commitRevision(db, id, { board: named(fixture, 'Amp'), author: 'Cy', how: 'undo', target: 2 })
  return id
}

describe('bundle export and import', () => {
  it('bundle export then import recreates the board with every revision, authors marked imported', () => {
    const id = historyBoard()
    const out = exportBundle(db, { key: id, who: local })
    expect(out.status).toBe(200)
    expect(out.headers?.['content-disposition']).toBe('attachment; filename="Amp.wirebender.zip"')
    const res = importBundle(db, bytesOf(out), local)
    expect(res.status).toBe(201)
    const body = res.body as { id: string, name: string, head: number, revisions: number }
    expect(body).toMatchObject({ name: 'Amp', head: 4, revisions: 3 })
    expect(body.id).not.toBe(id)
    const list = listRevisions(db, body.id).reverse()
    expect(list.map(r => [r.n, r.author, r.how, r.imported])).toEqual([
      [1, 'Ann', 'create', true], [2, 'Bob', 'edit', true], [3, 'Cy', 'undo', true], [4, 'Local', 'import', false]
    ])
    expect(list[3]!.summary).toBe('imported bundle (3 revisions)')
    expect(list[2]!.target).toBe(2)
    expect(db.select().from(boards).where(eq(boards.id, body.id)).get()).toMatchObject({ head: 4, name: 'Amp', ownerId: 'local' })
    // The original is untouched and not flagged.
    expect(listRevisions(db, id).every(r => !r.imported)).toBe(true)
  })

  it('import renumbers revisions and remaps undo targets; a missing target becomes null', () => {
    const b = (n: number) => ({ ...fixture, name: `R${n}`, revision: n })
    const bundle: Bundle = {
      name: 'Gappy', exportedAt: 1, board: b(9),
      revisions: [
        { n: 3, createdAt: 10, author: 'A', how: 'edit', target: null, summary: 's3', board: b(3) },
        { n: 7, createdAt: 20, author: 'B', how: 'edit', target: null, summary: 's7', board: b(7) },
        { n: 9, createdAt: 30, author: 'C', how: 'undo', target: 7, summary: 's9', board: b(9) },
        { n: 10, createdAt: 40, author: 'D', how: 'undo', target: 4, summary: 's10', board: b(9) }
      ]
    }
    const res = importBundle(db, encodeBundle(bundle), local)
    expect(res.status).toBe(201)
    const id = (res.body as { id: string }).id
    const rows = db.select().from(revisions).where(eq(revisions.boardId, id)).all().sort((x, y) => x.n - y.n)
    expect(rows.map(r => [r.n, r.target])).toEqual([[1, null], [2, null], [3, 2], [4, null], [5, null]])
    expect(rows.slice(0, 4).map(r => r.createdAt)).toEqual([10, 20, 30, 40])
    expect(JSON.parse(rows[1]!.board).revision).toBe(2)
  })

  it('stores an unknown how as import', () => {
    const bundle: Bundle = { name: 'X', exportedAt: 1, board: fixture, revisions: [{ n: 1, createdAt: 1, author: 'A', how: 'teleport', target: null, summary: 's', board: fixture }] }
    const id = (importBundle(db, encodeBundle(bundle), local).body as { id: string }).id
    expect(listRevisions(db, id).reverse()[0]!.how).toBe('import')
  })

  it('undo and redo work on an imported board', () => {
    const id = historyBoard()
    const imported = (importBundle(db, bytesOf(exportBundle(db, { key: id, who: local })), local).body as { id: string }).id
    const room = openRoom(db, imported)!
    const n = room.serverWrite(named(fixture, 'Edited'), { author: 'Local', how: 'api' })
    expect(room.undo('Local')).toBe(n + 1)
    expect(room.redo('Local')).toBe(n + 2)
    room.dropIfEmpty()
  })

  it('imported revisions carry no author_id or token_id', () => {
    const id = historyBoard()
    const imported = (importBundle(db, bytesOf(exportBundle(db, { key: id, who: local })), local).body as { id: string }).id
    const rows = db.select().from(revisions).where(eq(revisions.boardId, imported)).all()
    expect(rows.filter(x => x.imported === 1)).toHaveLength(3)
    for (const r of rows.filter(x => x.imported === 1)) expect([r.authorId, r.tokenId]).toEqual([null, null])
    const last = rows.find(r => r.n === 4)!
    expect(last.authorId).toBe('local')
    expect(last.imported).toBe(0)
  })

  it('a bad bundle creates nothing', () => {
    const garbage = importBundle(db, new Uint8Array([1, 2, 3, 4]), local)
    expect(garbage.status).toBe(422)
    const odd = importBundle(db, encodeBundle({ name: 'G', exportedAt: 1, board: { ...fixture, format: 'wirebender/9' } as unknown as BoardFile, revisions: [] }), local)
    expect(odd.status).toBe(422)
    // A board over the entry cap is 413.
    const big = encodeBundle({ name: 'B', exportedAt: 1, board: { ...fixture, name: 'x'.repeat(2_100_000) }, revisions: [] })
    expect(big.length).toBeLessThan(MAX_BUNDLE_BYTES)
    const huge = importBundle(db, big, local)
    expect(huge.status).toBe(413)
    expect((garbage.body as { error: string }).error).toEqual(expect.any(String))
    expect(db.select().from(boards).all()).toHaveLength(0)
    expect(db.select().from(revisions).all()).toHaveLength(0)
  })

  it('export needs view access; an edit link can export, a stranger gets 404', () => {
    const ann = account('Ann')
    const bob = account('Bob')
    const { id } = createBoard(db, named(fixture, 'Shared'), 'create', 'Ann', ann.userId, ann.userId)
    expect(exportBundle(db, { key: id, who: bob }).status).toBe(404)
    expect(exportBundle(db, { key: id, who: { kind: 'anonymous' } }).status).toBe(404)
    const row = db.select().from(boards).where(eq(boards.id, id)).get()!
    db.update(boards).set({ visibility: 'edit' }).where(eq(boards.id, id)).run()
    const viaLink = exportBundle(db, { key: row.linkId, who: bob })
    expect(viaLink.status).toBe(200)
    expect(JSON.parse(strFromU8(files(bytesOf(viaLink))['manifest.json']!)).format).toBe(BUNDLE_FORMAT)
    expect(exportBundle(db, { key: id, who: ann }).status).toBe(200)
  })
})

describe('download-all and admin export', () => {
  it('download-all holds one bundle per board, excluding trash, with duplicate names numbered', () => {
    for (const name of ['Amp', 'Amp', 'Amp', 'Other']) createBoard(db, named(fixture, name), 'create', 'Local')
    const gone = createBoard(db, named(fixture, 'Trashed'), 'create', 'Local')
    db.update(boards).set({ trashedAt: 1 }).where(eq(boards.id, gone.id)).run()
    const entries = files(exportAll(db, 'local'))
    expect(Object.keys(entries).sort()).toEqual(['Amp (2).wirebender.zip', 'Amp (3).wirebender.zip', 'Amp.wirebender.zip', 'Other.wirebender.zip'])
    expect(Object.keys(files(entries['Other.wirebender.zip']!))).toContain('board.wirebender.json')
    expect(listBoards(db, 'local', 'mine')).toHaveLength(4)
  })

  it('admin export holds every account\'s boards; a non-admin gets 403', () => {
    const admin = account('Root', true)
    const bob = account('Bob')
    createBoard(db, named(fixture, 'A'), 'create', 'Root', admin.userId, admin.userId)
    createBoard(db, named(fixture, 'B'), 'create', 'Bob', bob.userId, bob.userId)
    createBoard(db, named(fixture, 'B'), 'create', 'Bob', bob.userId, bob.userId)
    expect(Object.keys(files(exportServer(db))).sort()).toEqual(['Bob/B (2).wirebender.zip', 'Bob/B.wirebender.zip', 'Root/A.wirebender.zip'])
    const ok = exportServerResult(db, admin)
    expect(ok.status).toBe(200)
    expect(ok.headers?.['content-disposition']).toMatch(/^attachment; filename="wirebender-server-\d{4}-\d{2}-\d{2}\.zip"$/)
    for (const who of [bob, local, { kind: 'anonymous' } as Who]) expect(exportServerResult(db, who).status).toBe(403)
  })

  it('a token can export and import a bundle', () => {
    expect(tokenRefusal('/api/boards/abc/bundle', 'GET')).toBe(false)
    expect(tokenRefusal('/api/boards/import-bundle', 'POST')).toBe(false)
    expect(tokenRefusal('/api/me/export', 'GET')).toBe(false)
    expect(tokenRefusal('/api/admin/export', 'GET')).toBe(true)
    const ann = account('Ann')
    const viaToken: Who = { ...ann, author: 'cli · Ann', token: { id: 't1', name: 'cli' } }
    const id = historyBoard(ann.userId)
    expect(exportBundle(db, { key: id, who: viaToken }).status).toBe(200)
    const res = importBundle(db, bytesOf(exportBundle(db, { key: id, who: viaToken })), viaToken)
    expect(res.status).toBe(201)
    const last = db.select().from(revisions).where(eq(revisions.boardId, (res.body as { id: string }).id)).all().find(r => r.n === 4)!
    expect([last.author, last.authorId, last.tokenId]).toEqual(['cli · Ann', ann.userId, 't1'])
  })
})

describe('the migration', () => {
  it('the migration only adds a column', () => {
    const sqlFiles = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const sql = readFileSync(path.join(MIGRATIONS, sqlFiles.at(-1)!), 'utf8')
    expect(sql).toMatch(/ALTER TABLE `revisions` ADD `imported` integer DEFAULT 0 NOT NULL/)
    expect(sql).not.toMatch(/DROP|CREATE TABLE|RENAME|INSERT/i)
  })
})
