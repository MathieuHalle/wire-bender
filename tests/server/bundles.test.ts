// Board bundles on the server: export, import, download-all and the admin export.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUNDLE_FORMAT, MAX_BUNDLE_BYTES, encodeBundle, type Bundle } from '../../core/bundle'
import { parseBoard, type BoardFile } from '../../core/schema'
import { openDb, type Db } from '../../server/db'
import { boards, revisions, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { beginExport, endExport, exportAll, exportAllResult, exportBundle, exportServer, exportServerResult, importBundle, resetExportRate, EXPORTS_PER_MINUTE, TOO_MANY_EXPORTS } from '../../server/utils/bundles'
import { tokenRefusal } from '../../server/utils/access'
import { MAX_BOARD_BYTES, commitRevision, createBoard, getBoard, listBoards, listRevisions } from '../../server/utils/boards'
import { CREATES_PER_MINUTE, resetCreateRate, withCreateLimit } from '../../server/utils/lifecycle'
import { openRoom } from '../../server/utils/rooms'
import type { Who } from '../../server/utils/who'

const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
const MIGRATIONS = path.resolve(__dirname, '../../server/db/migrations')

let dir: string
let db: Db
beforeEach(() => {
  resetCreateRate()
  resetExportRate()
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

  it('a board just under the server\'s board cap exports and re-imports (I2)', () => {
    // Measured as the server measures it: the parsed board (defaults filled in), compact.
    const parsed = parseBoard(fixture)
    if (!parsed.ok) throw new Error('fixture')
    const base0 = parsed.board
    const cls = Object.values(base0.nets)[0]!.class
    const nets = { ...base0.nets }
    const size = () => Buffer.byteLength(JSON.stringify({ ...base0, name: 'Big', nets, revision: 9 }))
    // Each added net is the same number of bytes, so the count that lands just under the cap is known.
    const base = size()
    nets.X0000000 = { class: cls }
    const each = size() - base
    const count = Math.floor((MAX_BOARD_BYTES - base) / each)
    for (let i = 1; i < count; i++) nets[`X${String(i).padStart(7, '0')}`] = { class: cls }
    const big: BoardFile = { ...base0, name: 'Big', nets }
    expect(size()).toBeLessThanOrEqual(MAX_BOARD_BYTES)
    expect(size()).toBeGreaterThan(MAX_BOARD_BYTES - each)
    const { id } = createBoard(db, big, 'create', 'Ann')
    commitRevision(db, id, { board: { ...big, nets: { ...nets } }, author: 'Bob', how: 'edit' })
    const out = exportBundle(db, { key: id, who: local })
    expect(out.status).toBe(200)
    const res = importBundle(db, bytesOf(out), local)
    expect(res).toMatchObject({ status: 201, body: { head: 3, revisions: 2 } })
    const imported = getBoard(db, (res.body as { id: string }).id)!
    expect(Object.keys(imported.board.nets)).toHaveLength(Object.keys(nets).length)
  })

  it('a hand-made bundle whose first revision is an edit: #1 imports as `import`, a forward target is dropped, undo works', () => {
    const rev = (n: number, how: string, target: number | null, name: string) => ({ n, createdAt: n, author: 'A', how, target, summary: 's', board: named(fixture, name) })
    const bundle: Bundle = { name: 'H', exportedAt: 1, board: named(fixture, 'Three'), revisions: [rev(1, 'edit', null, 'One'), rev(2, 'edit', 5, 'Two'), rev(3, 'undo', 3, 'Three')] }
    const id = (importBundle(db, encodeBundle(bundle), local).body as { id: string }).id
    const rows = db.select().from(revisions).where(eq(revisions.boardId, id)).orderBy(revisions.n).all()
    expect(rows.map(r => [r.n, r.how, r.target])).toEqual([[1, 'import', null], [2, 'edit', null], [3, 'undo', null], [4, 'import', null]])
    const room = openRoom(db, id)!
    const undone = room.undo('Local')
    expect(undone).toBe(5)
    expect(getBoard(db, id)!.board.name).toBe('One')
    // #2 was the only edit: nothing older to undo, and no "no revision 0".
    expect(room.undo('Local')).toBeNull()
    expect(room.redo('Local')).toBe(6)
    expect(getBoard(db, id)!.board.name).toBe('Two')
    room.dropIfEmpty()
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

  it('a view link can export; a private board\'s link cannot', () => {
    const ann = account('Ann')
    const bob = account('Bob')
    const { id } = createBoard(db, named(fixture, 'Shared'), 'create', 'Ann', ann.userId, ann.userId)
    const row = db.select().from(boards).where(eq(boards.id, id)).get()!
    db.update(boards).set({ visibility: 'view' }).where(eq(boards.id, id)).run()
    expect(exportBundle(db, { key: row.linkId, who: bob }).status).toBe(200)
    expect(exportBundle(db, { key: row.linkId, who: { kind: 'anonymous' } }).status).toBe(200)
    db.update(boards).set({ visibility: 'private' }).where(eq(boards.id, id)).run()
    expect(exportBundle(db, { key: row.linkId, who: bob }).status).toBe(404)
  })

  it('the download filename is header-safe', () => {
    const { id } = createBoard(db, named(fixture, 'a"b\r\nc/d é'), 'create', 'Local')
    const header = exportBundle(db, { key: id, who: local }).headers!['content-disposition']!
    expect(header).toBe('attachment; filename="a-b--c-d--.wirebender.zip"')
  })

  it('a failure while importing leaves no board and no revisions', () => {
    db.$client.exec('CREATE TRIGGER boom BEFORE INSERT ON revisions WHEN NEW.how = \'import\' AND NEW.imported = 0 BEGIN SELECT RAISE(ABORT, \'boom\'); END')
    const zip = encodeBundle({ name: 'G', exportedAt: 1, board: fixture, revisions: [{ n: 1, createdAt: 1, author: 'A', how: 'edit', target: null, summary: 's', board: fixture }] })
    expect(() => importBundle(db, zip, local)).toThrow('boom')
    expect(db.select().from(boards).all()).toHaveLength(0)
    expect(db.select().from(revisions).all()).toHaveLength(0)
  })

  it('imports count toward the create rate', () => {
    const ann = account('Ann')
    const zip = encodeBundle({ name: 'G', exportedAt: 1, board: fixture, revisions: [] })
    for (let i = 0; i < CREATES_PER_MINUTE; i++) expect(withCreateLimit(db, ann, () => importBundle(db, zip, ann), 1000).status).toBe(201)
    expect(withCreateLimit(db, ann, () => importBundle(db, zip, ann), 1000).status).toBe(429)
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

  it('numbers duplicate names case-insensitively and replaces characters Windows refuses', () => {
    for (const name of ['Amp', 'amp', 'a/b\\c:d*e?f"g<h>i|j']) createBoard(db, named(fixture, name), 'create', 'Local')
    // Boards made in the same millisecond tie on createdAt and fall back to their random id, so either may be first.
    const keys = Object.keys(files(exportAll(db, 'local'))).sort()
    expect([
      ['Amp.wirebender.zip', 'a_b_c_d_e_f_g_h_i_j.wirebender.zip', 'amp (2).wirebender.zip'],
      ['Amp (2).wirebender.zip', 'a_b_c_d_e_f_g_h_i_j.wirebender.zip', 'amp.wirebender.zip']
    ]).toContainEqual(keys)
  })

  it('a download-all with no boards is an empty zip, and anonymous gets 401', () => {
    expect(Object.keys(files(exportAll(db, 'local')))).toEqual([])
    expect(exportAllResult(db, { kind: 'anonymous' }).status).toBe(401)
    expect(exportAllResult(db, local).headers?.['content-disposition']).toMatch(/^attachment; filename="wirebender-boards-\d{4}-\d{2}-\d{2}\.zip"$/)
  })

  it('download-all allows one export at a time and six a minute per user', () => {
    expect(exportAllResult(db, local, 1000).status).toBe(200)
    expect(beginExport('local', 1000)).toBeNull()
    expect(exportAllResult(db, local, 1000).status).toBe(429)
    endExport('local')
    expect(exportAllResult(db, local, 1000).status).toBe(200)
    for (let i = 3; i < EXPORTS_PER_MINUTE; i++) expect(exportAllResult(db, local, 1000 + i).status).toBe(200)
    expect(exportAllResult(db, local, 2000).status).toBe(429)
    expect(exportAllResult(db, local, 1000 + 61_000).status).toBe(200)
  })

  it('a board bundle is throttled the same way, per user, sharing download-all\'s count', () => {
    const { id } = createBoard(db, named(fixture, 'Amp'), 'create', 'Local')
    for (let i = 0; i < EXPORTS_PER_MINUTE - 1; i++) expect(exportBundle(db, { key: id, who: local }, undefined, 1000).status).toBe(200)
    expect(exportAllResult(db, local, 1000).status).toBe(200)
    const refused = exportBundle(db, { key: id, who: local }, undefined, 1000)
    expect(refused).toEqual({ status: 429, body: { error: TOO_MANY_EXPORTS } })
    expect(exportBundle(db, { key: id, who: local }, undefined, 62_000).status).toBe(200)
  })

  it('anonymous bundle downloads on a view link are throttled per client address', () => {
    const ann = account('Ann')
    const { id } = createBoard(db, named(fixture, 'Shared'), 'create', 'Ann', ann.userId, ann.userId)
    db.update(boards).set({ visibility: 'view' }).where(eq(boards.id, id)).run()
    const linkId = db.select().from(boards).where(eq(boards.id, id)).get()!.linkId
    const anon: Who = { kind: 'anonymous' }
    for (let i = 0; i < EXPORTS_PER_MINUTE; i++) expect(exportBundle(db, { key: linkId, who: anon }, '203.0.113.5', 1000).status).toBe(200)
    expect(exportBundle(db, { key: linkId, who: anon }, '203.0.113.5', 1000).status).toBe(429)
    expect(exportBundle(db, { key: linkId, who: anon }, '203.0.113.6', 1000).status).toBe(200)
    // The owner's own count is apart from the anonymous callers'.
    expect(exportBundle(db, { key: id, who: ann }, '203.0.113.5', 1000).status).toBe(200)
  })

  it('a refused bundle (404) does not use up the count', () => {
    for (let i = 0; i < EXPORTS_PER_MINUTE + 1; i++) expect(exportBundle(db, { key: 'nope', who: local }, undefined, 1000).status).toBe(404)
    expect(exportAllResult(db, local, 1000).status).toBe(200)
  })

  it('the admin export is throttled the same way', () => {
    const admin = account('Root', true)
    for (let i = 0; i < EXPORTS_PER_MINUTE; i++) expect(exportServerResult(db, admin, 1000).status).toBe(200)
    expect(exportServerResult(db, admin, 1000).status).toBe(429)
  })

  it('names that are empty or only dots, and slashes, cannot make an entry climb out', () => {
    const admin = account('Root', true)
    const dots = account('..')
    const blank = account('.')
    createBoard(db, named(fixture, '../x'), 'create', 'Root', dots.userId, dots.userId)
    createBoard(db, named(fixture, '..'), 'create', 'Root', blank.userId, blank.userId)
    createBoard(db, named(fixture, 'ok'), 'create', 'Root', admin.userId, admin.userId)
    const names = Object.keys(files(exportServer(db)))
    expect(names).toHaveLength(3)
    for (const n of names) {
      expect(n.split('/').every(seg => seg !== '' && !/^\.+$/.test(seg)), n).toBe(true)
      expect(n.startsWith('/')).toBe(false)
      expect(n.split('/')).toHaveLength(2)
    }
  })

  it('admin export holds every account\'s boards; a non-admin gets 404', () => {
    const admin = account('Root', true)
    const bob = account('Bob')
    createBoard(db, named(fixture, 'A'), 'create', 'Root', admin.userId, admin.userId)
    createBoard(db, named(fixture, 'B'), 'create', 'Bob', bob.userId, bob.userId)
    createBoard(db, named(fixture, 'B'), 'create', 'Bob', bob.userId, bob.userId)
    expect(Object.keys(files(exportServer(db))).sort()).toEqual(['Bob/B (2).wirebender.zip', 'Bob/B.wirebender.zip', 'Root/A.wirebender.zip'])
    // Folders that differ only by case are numbered too.
    const bob2 = account('bob')
    createBoard(db, named(fixture, 'C'), 'create', 'bob', bob2.userId, bob2.userId)
    expect(Object.keys(files(exportServer(db)))).toContain('bob (2)/C.wirebender.zip')
    const ok = exportServerResult(db, admin)
    expect(ok.status).toBe(200)
    expect(ok.headers?.['content-disposition']).toMatch(/^attachment; filename="wirebender-server-\d{4}-\d{2}-\d{2}\.zip"$/)
    for (const who of [bob, local, { kind: 'anonymous' } as Who]) expect(exportServerResult(db, who).status).toBe(404)
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
  const migration = (n: string) => readFileSync(path.join(MIGRATIONS, readdirSync(MIGRATIONS).find(f => f.startsWith(`${n}_`) && f.endsWith('.sql'))!), 'utf8')
  it('the migration only adds a column', () => {
    const sql = migration('0004')
    expect(sql).toMatch(/ALTER TABLE `revisions` ADD `imported` integer DEFAULT 0 NOT NULL/)
    expect(sql).not.toMatch(/DROP|CREATE TABLE|RENAME|INSERT/i)
  })
  it('the sealed link password migration only adds a nullable column', () => {
    const sql = migration('0005')
    expect(sql.trim()).toBe('ALTER TABLE `boards` ADD `password_sealed` text;')
  })
})
