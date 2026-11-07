import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { BoardFile } from '~core/schema'
import { summarize } from '#shared/summary'
import { stable } from '#shared/yboard'
import type { Db } from '../db'
import { boards, revisions, type RevisionHow } from '../db/schema'

export interface BoardInfo { id: string, name: string, head: number, createdAt: number, updatedAt: number }
export interface RevisionInfo { n: number, createdAt: number, author: string, how: RevisionHow, target: number | null, summary: string }

function withRevision(board: BoardFile, revision: number): BoardFile {
  return { ...board, revision }
}

function boardRow(db: Db, id: string) {
  return db.select().from(boards).where(eq(boards.id, id)).get()
}

function revisionBoard(db: Db, id: string, n: number): BoardFile | null {
  const row = db.select({ board: revisions.board }).from(revisions).where(and(eq(revisions.boardId, id), eq(revisions.n, n))).get()
  return row ? withRevision(JSON.parse(row.board) as BoardFile, n) : null
}

/** Insert a new board with revision 1. */
export function createBoard(db: Db, board: BoardFile, how: 'create' | 'import', author: string): { id: string, head: 1 } {
  const id = randomUUID()
  const now = Date.now()
  const stored = JSON.stringify(withRevision(board, 1))
  db.transaction((tx) => {
    tx.insert(boards).values({ id, name: board.name, createdAt: now, updatedAt: now, current: stored, head: 1 }).run()
    tx.insert(revisions).values({ boardId: id, n: 1, createdAt: now, author, how, target: null, summary: summarize(null, board), board: stored }).run()
  })
  return { id, head: 1 }
}

export function getBoard(db: Db, id: string): { id: string, name: string, head: number, board: BoardFile } | null {
  const row = boardRow(db, id)
  if (!row) return null
  return { id: row.id, name: row.name, head: row.head, board: withRevision(JSON.parse(row.current) as BoardFile, row.head) }
}

/** Store the current state only; makes no revision. */
export function saveCurrent(db: Db, id: string, board: BoardFile): void {
  db.update(boards).set({ current: JSON.stringify(board), updatedAt: Date.now() }).where(eq(boards.id, id)).run()
}

/** Append revision `head + 1` and make it the board's current state, in one transaction. */
export function commitRevision(db: Db, id: string, r: { board: BoardFile, author: string, how: string, target?: number }): number {
  return db.transaction((tx) => {
    const row = tx.select().from(boards).where(eq(boards.id, id)).get()
    if (!row) throw new Error(`no board ${id}`)
    const n = row.head + 1
    const now = Date.now()
    const stored = JSON.stringify(withRevision(r.board, n))
    const previous = revisionBoard(tx as unknown as Db, id, row.head)
    tx.insert(revisions).values({
      boardId: id, n, createdAt: now, author: r.author, how: r.how as RevisionHow, target: r.target ?? null,
      summary: summarize(previous, r.board), board: stored
    }).run()
    tx.update(boards).set({ current: stored, head: n, name: r.board.name, updatedAt: now }).where(eq(boards.id, id)).run()
    return n
  })
}

/** The board as it was before revision `n`, i.e. revision `n - 1`. */
export function boardBefore(db: Db, id: string, n: number): BoardFile {
  const board = revisionBoard(db, id, n - 1)
  if (!board) throw new Error(`no revision ${n - 1} on board ${id}`)
  return board
}

export function listBoards(db: Db): BoardInfo[] {
  return db.select({ id: boards.id, name: boards.name, head: boards.head, createdAt: boards.createdAt, updatedAt: boards.updatedAt })
    .from(boards).orderBy(desc(boards.updatedAt)).all()
}

/** Newest first, without the board JSON. */
export function listRevisions(db: Db, id: string): RevisionInfo[] {
  return db.select({
    n: revisions.n, createdAt: revisions.createdAt, author: revisions.author, how: revisions.how, target: revisions.target, summary: revisions.summary
  }).from(revisions).where(eq(revisions.boardId, id)).orderBy(desc(revisions.n)).all()
}

export function getRevision(db: Db, id: string, n: number): (RevisionInfo & { board: BoardFile }) | null {
  const row = db.select().from(revisions).where(and(eq(revisions.boardId, id), eq(revisions.n, n))).get()
  if (!row) return null
  return {
    n: row.n, createdAt: row.createdAt, author: row.author, how: row.how, target: row.target, summary: row.summary,
    board: withRevision(JSON.parse(row.board) as BoardFile, row.n)
  }
}

/** If `current` differs from the head revision's board, commit it as a `recovered` revision. */
export function recover(db: Db, id: string): number | null {
  const row = boardRow(db, id)
  if (!row) return null
  const head = revisionBoard(db, id, row.head)
  const current = withRevision(JSON.parse(row.current) as BoardFile, row.head)
  if (head && stable(head) === stable(current)) return null
  return commitRevision(db, id, { board: current, author: 'Recovered', how: 'recovered' })
}
