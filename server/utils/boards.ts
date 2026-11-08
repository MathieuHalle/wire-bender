import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { BoardFile } from '~core/schema'
import { summarize } from '#shared/summary'
import { sameItems } from '#shared/yboard'
import type { Db } from '../db'
import { boards, linkVisits, revisions, users, type BoardVisibility, type RevisionHow } from '../db/schema'

/** The largest board, and API request body, in bytes (spec §13); the live socket keeps to it too. */
export const MAX_BOARD_BYTES = 2_000_000

/** A board in the owner's list; `author` made its head revision. */
export interface BoardInfo {
  id: string
  name: string
  head: number
  createdAt: number
  updatedAt: number
  author: string
  visibility: BoardVisibility
  hasPassword: boolean
  trashedAt: number | null
}

/** A board in "Shared with me": reached by its link only, so it carries the link id, never the board id. */
export interface SharedInfo { key: string, name: string, owner: string, role: 'view' | 'edit', lastOpened: number }
export interface RevisionInfo { n: number, createdAt: number, author: string, how: RevisionHow, target: number | null, summary: string }

function withRevision(board: BoardFile, revision: number): BoardFile {
  return { ...board, revision }
}

export function getBoardRow(db: Db, id: string) {
  return db.select().from(boards).where(eq(boards.id, id)).get()
}

function revisionBoard(db: Db, id: string, n: number): BoardFile | null {
  const row = db.select({ board: revisions.board }).from(revisions).where(and(eq(revisions.boardId, id), eq(revisions.n, n))).get()
  return row ? withRevision(JSON.parse(row.board) as BoardFile, n) : null
}

/** A fork's revision 1: its summary, the board it was forked from and the link it came by (null by board id). */
export interface ForkOf { summary: string, forkedFrom: string, forkedFromLink: string | null }

/** Insert a new board with revision 1. */
export function createBoard(db: Db, board: BoardFile, how: 'create' | 'import' | 'fork', author: string, ownerId = 'local', authorId?: string | null, fork?: ForkOf): { id: string, head: 1 } {
  const id = randomUUID()
  const now = Date.now()
  const stored = JSON.stringify(withRevision(board, 1))
  db.transaction((tx) => {
    tx.insert(boards).values({ id, name: board.name, createdAt: now, updatedAt: now, current: stored, head: 1, ownerId, linkId: randomUUID(), forkedFrom: fork?.forkedFrom ?? null, forkedFromLink: fork?.forkedFromLink ?? null }).run()
    tx.insert(revisions).values({ boardId: id, n: 1, createdAt: now, author, how, target: null, summary: fork?.summary ?? summarize(null, board), board: stored, authorId: authorId ?? null }).run()
  })
  return { id, head: 1 }
}

export function getBoard(db: Db, id: string): { id: string, name: string, head: number, board: BoardFile } | null {
  const row = getBoardRow(db, id)
  if (!row) return null
  return { id: row.id, name: row.name, head: row.head, board: withRevision(JSON.parse(row.current) as BoardFile, row.head) }
}

/** Store the current state only; makes no revision. */
export function saveCurrent(db: Db, id: string, board: BoardFile): void {
  db.update(boards).set({ current: JSON.stringify(board), updatedAt: Date.now() }).where(eq(boards.id, id)).run()
}

/** Append revision `head + 1` and make it the board's current state, in one transaction. */
export function commitRevision(db: Db, id: string, r: { board: BoardFile, author: string, how: string, target?: number, authorId?: string | null }): number {
  return db.transaction((tx) => {
    const row = tx.select().from(boards).where(eq(boards.id, id)).get()
    if (!row) throw new Error(`no board ${id}`)
    const n = row.head + 1
    const now = Date.now()
    const stored = JSON.stringify(withRevision(r.board, n))
    const previous = revisionBoard(tx as unknown as Db, id, row.head)
    tx.insert(revisions).values({
      boardId: id, n, createdAt: now, author: r.author, how: r.how as RevisionHow, target: r.target ?? null,
      summary: summarize(previous, r.board), board: stored, authorId: r.authorId ?? null
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

export function getBoardByLink(db: Db, linkId: string) {
  return db.select().from(boards).where(eq(boards.linkId, linkId)).get() ?? null
}

/** `ownerId`'s boards, newest change first: `mine` leaves out the trashed ones, `trash` lists only those. */
export function listBoards(db: Db, ownerId: string, which: 'mine' | 'trash'): BoardInfo[] {
  return db.select({
    id: boards.id, name: boards.name, head: boards.head, createdAt: boards.createdAt, updatedAt: boards.updatedAt, author: revisions.author,
    visibility: boards.visibility, hasPassword: sql<number>`${boards.passwordHash} is not null`, trashedAt: boards.trashedAt
  })
    .from(boards)
    .innerJoin(revisions, and(eq(revisions.boardId, boards.id), eq(revisions.n, boards.head)))
    .where(and(eq(boards.ownerId, ownerId), which === 'mine' ? isNull(boards.trashedAt) : isNotNull(boards.trashedAt)))
    .orderBy(desc(boards.updatedAt)).all()
    .map(b => ({ ...b, hasPassword: b.hasPassword === 1 }))
}

/**
 * `userId`'s "Shared with me": the boards they opened by link whose link still opens, most
 * recently opened first. A visit keeps the link id it was made with, so a regenerated link
 * drops out; so do private and trashed boards, and those of a deleted or suspended account. A link
 * password does not: the board asks for it when opened.
 */
export function listShared(db: Db, userId: string): SharedInfo[] {
  return db.select({ key: boards.linkId, name: boards.name, owner: users.name, role: boards.visibility, lastOpened: linkVisits.lastOpened })
    .from(linkVisits)
    .innerJoin(boards, and(eq(boards.id, linkVisits.boardId), eq(boards.linkId, linkVisits.linkId)))
    .innerJoin(users, eq(users.id, boards.ownerId))
    .where(and(eq(linkVisits.userId, userId), ne(boards.ownerId, userId), ne(boards.visibility, 'private'), isNull(boards.trashedAt), isNull(users.deletedAt), isNull(users.suspendedAt)))
    .orderBy(desc(linkVisits.lastOpened)).all() as SharedInfo[]
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
  const row = getBoardRow(db, id)
  if (!row) return null
  const head = revisionBoard(db, id, row.head)
  const current = withRevision(JSON.parse(row.current) as BoardFile, row.head)
  if (head && sameItems(head, current)) return null
  return commitRevision(db, id, { board: current, author: 'Recovered', how: 'recovered' })
}
