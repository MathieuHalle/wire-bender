import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBoard, type BoardFile } from '../../core/schema'
import { openDb } from '../../server/db'
import { boards } from '../../server/db/schema'
import { eq } from 'drizzle-orm'
import { boardBefore, commitRevision, createBoard, getBoard, getBoardByLink, getBoardRow, getRevision, listBoards, listRevisions, recover, saveCurrent } from '../../server/utils/boards'
import { undoState } from '../../shared/undoState'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-boards-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fixture(): BoardFile {
  const r = parseBoard(JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')))
  if (!r.ok) throw new Error(r.errors.join())
  return r.board
}
function renamed(b: BoardFile, name: string): BoardFile {
  return { ...b, name }
}

describe('boards', () => {
  it('creates a board at revision 1 and reads it back with revision = head', () => {
    const db = openDb(dir)
    const { id, head } = createBoard(db, fixture(), 'create', 'Local', 'local')
    expect(head).toBe(1)
    const got = getBoard(db, id)!
    expect(got.head).toBe(1)
    expect(got.board.revision).toBe(1)
    expect(got.name).toBe(fixture().name)
    expect(getBoard(db, 'nope')).toBeNull()
    expect(listBoards(db, 'local', 'mine').map(b => b.id)).toEqual([id])
    commitRevision(db, id, { board: renamed(fixture(), 'b'), author: 'Claude', how: 'api' })
    expect(listBoards(db, 'local', 'mine').map(b => [b.id, b.name, b.head, b.author])).toEqual([[id, 'b', 2, 'Claude']])
  })

  it('commitRevision only inserts', () => {
    const db = openDb(dir)
    const { id } = createBoard(db, fixture(), 'create', 'Local', 'local')
    const rows = () => db.$client.prepare('SELECT * FROM revisions WHERE board_id = ? ORDER BY n').all(id)
    expect(commitRevision(db, id, { board: renamed(fixture(), 'a'), author: 'Local', how: 'edit' })).toBe(2)
    const before = JSON.stringify(rows())
    expect(commitRevision(db, id, { board: renamed(fixture(), 'b'), author: 'Local', how: 'edit' })).toBe(3)
    const after = rows()
    expect(after).toHaveLength(3)
    expect(JSON.stringify(after.slice(0, 2))).toBe(before)
    expect(getBoard(db, id)!.head).toBe(3)
    expect(listRevisions(db, id).map(r => r.n)).toEqual([3, 2, 1])
    expect(listRevisions(db, id)[0]).not.toHaveProperty('board')
    expect(getRevision(db, id, 2)!.board.name).toBe('a')
  })

  it('undo reverts the latest change, whoever made it', () => {
    const db = openDb(dir)
    const { id } = createBoard(db, fixture(), 'create', 'Local', 'local')
    commitRevision(db, id, { board: renamed(fixture(), 'local edit'), author: 'Local', how: 'edit' })
    const n3 = commitRevision(db, id, { board: renamed(fixture(), 'claude edit'), author: 'Claude', how: 'api' })
    const { undo } = undoState(listRevisions(db, id).reverse())
    expect(undo).toBe(n3)
    const n4 = commitRevision(db, id, { board: boardBefore(db, id, undo!), author: 'Local', how: 'undo', target: undo! })
    expect(getBoard(db, id)!.board.name).toBe('local edit')
    expect(listRevisions(db, id)[0]).toMatchObject({ n: n4, how: 'undo', target: n3 })
  })

  it('edits since the last revision survive a restart', () => {
    const db = openDb(dir)
    const { id } = createBoard(db, fixture(), 'create', 'Local', 'local')
    expect(recover(db, id)).toBeNull()
    saveCurrent(db, id, renamed(fixture(), 'unsaved'))
    db.$client.close()
    const db2 = openDb(dir)
    expect(recover(db2, id)).toBe(2)
    expect(getRevision(db2, id, 2)!.board.name).toBe('unsaved')
    expect(listRevisions(db2, id)[0]).toMatchObject({ how: 'recovered' })
    expect(recover(db2, id)).toBeNull()
  })

  it('recover ignores the order of a section (doc order vs file order)', () => {
    const db = openDb(dir)
    const { id } = createBoard(db, fixture(), 'create', 'Local', 'local')
    saveCurrent(db, id, { ...fixture(), trails: [...fixture().trails].reverse() })
    expect(recover(db, id)).toBeNull()
    expect(listRevisions(db, id)).toHaveLength(1)
    db.$client.close()
  })

  it('recover ignores key order in the saved current state', () => {
    const db = openDb(dir)
    const { id } = createBoard(db, fixture(), 'create', 'Local', 'local')
    const head = getBoard(db, id)!.board
    const reordered = Object.fromEntries(Object.entries(head).reverse()) as unknown as BoardFile
    saveCurrent(db, id, reordered)
    expect(recover(db, id)).toBeNull()
    expect(listRevisions(db, id)).toHaveLength(1)
  })
})

describe('ownership and trash', () => {
  it('link ids are unique and findable', () => {
    const db = openDb(dir)
    const a = createBoard(db, fixture(), 'create', 'Local')
    const b = createBoard(db, fixture(), 'create', 'Local')
    const ra = getBoardRow(db, a.id)!
    const rb = getBoardRow(db, b.id)!
    expect(ra.linkId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ra.linkId).not.toBe(rb.linkId)
    expect(getBoardByLink(db, rb.linkId)!.id).toBe(b.id)
    expect(getBoardByLink(db, 'nope')).toBeNull()
    expect(() => db.update(boards).set({ linkId: ra.linkId }).where(eq(boards.id, b.id)).run()).toThrow(/UNIQUE/)
    expect([ra.ownerId, ra.visibility, ra.trashedAt, ra.passwordHash, ra.forkedFrom]).toEqual(['local', 'view', null, null, null])
    db.$client.close()
  })

  it('listBoards excludes trashed from mine and lists them in trash', () => {
    const db = openDb(dir)
    db.$client.prepare('INSERT INTO users (id, name, is_admin, is_premium, created_at) VALUES (\'u2\', \'U2\', 0, 0, 1)').run()
    const a = createBoard(db, fixture(), 'create', 'Local')
    const b = createBoard(db, fixture(), 'create', 'Local')
    const c = createBoard(db, fixture(), 'create', 'U2', 'u2', 'u2')
    db.update(boards).set({ trashedAt: Date.now() }).where(eq(boards.id, b.id)).run()
    expect(listBoards(db, 'local', 'mine').map(x => x.id)).toEqual([a.id])
    expect(listBoards(db, 'local', 'trash').map(x => x.id)).toEqual([b.id])
    expect(listBoards(db, 'u2', 'mine').map(x => x.id)).toEqual([c.id])
    expect(db.$client.prepare('SELECT author_id FROM revisions WHERE board_id = ?').get(c.id)).toEqual({ author_id: 'u2' })
    const n = commitRevision(db, c.id, { board: renamed(fixture(), 'x'), author: 'U2', how: 'edit', authorId: 'u2' })
    expect(db.$client.prepare('SELECT author_id FROM revisions WHERE board_id = ? AND n = ?').get(c.id, n)).toEqual({ author_id: 'u2' })
    db.$client.close()
  })
})
