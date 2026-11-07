import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBoard, type BoardFile } from '../../core/schema'
import { openDb } from '../../server/db'
import { boardBefore, commitRevision, createBoard, getBoard, getRevision, listBoards, listRevisions, recover, saveCurrent } from '../../server/utils/boards'
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
    const { id, head } = createBoard(db, fixture(), 'create', 'Local')
    expect(head).toBe(1)
    const got = getBoard(db, id)!
    expect(got.head).toBe(1)
    expect(got.board.revision).toBe(1)
    expect(got.name).toBe(fixture().name)
    expect(getBoard(db, 'nope')).toBeNull()
    expect(listBoards(db).map(b => b.id)).toEqual([id])
  })

  it('commitRevision only inserts', () => {
    const db = openDb(dir)
    const { id } = createBoard(db, fixture(), 'create', 'Local')
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
    const { id } = createBoard(db, fixture(), 'create', 'Local')
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
    const { id } = createBoard(db, fixture(), 'create', 'Local')
    expect(recover(db, id)).toBeNull()
    saveCurrent(db, id, renamed(fixture(), 'unsaved'))
    db.$client.close()
    const db2 = openDb(dir)
    expect(recover(db2, id)).toBe(2)
    expect(getRevision(db2, id, 2)!.board.name).toBe('unsaved')
    expect(listRevisions(db2, id)[0]).toMatchObject({ how: 'recovered' })
    expect(recover(db2, id)).toBeNull()
  })

  it('recover ignores key order in the saved current state', () => {
    const db = openDb(dir)
    const { id } = createBoard(db, fixture(), 'create', 'Local')
    const head = getBoard(db, id)!.board
    const reordered = Object.fromEntries(Object.entries(head).reverse()) as unknown as BoardFile
    saveCurrent(db, id, reordered)
    expect(recover(db, id)).toBeNull()
    expect(listRevisions(db, id)).toHaveLength(1)
  })
})
