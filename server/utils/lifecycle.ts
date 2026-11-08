// A board's life after it is made (spec §4): fork or duplicate, the trash, deletion for good,
// and an account's deletion and restore. Nothing is overwritten (Global Constraints): rows
// are deleted only by `purge` (30 days after a board was trashed or an account deleted) and
// by `deleteBoardForGood`, the owner's one immediate delete, of a board already in the trash.
//
// Limits (Global Constraints) hold for signed-in accounts: boards not in the trash are
// capped, and creates, imports, forks and duplicates are rate-limited per user. The local
// user (one trusted machine and its paired devices) has none. The rate counters live in
// memory; a restart drops them.
import { and, count, eq, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm'
import type { Db } from '../db'
import { boards, identities, linkVisits, revisions, users } from '../db/schema'
import { invalid, notFound, parseBody, withAccess, withOwner, type ApiResult, type BoardRequest } from './api'
import { createBoard, getBoard, getBoardRow } from './boards'
import { closeRoom, kickAccount, kickNonOwnerPeers } from './rooms'
import type { Who } from './who'

export const TRASH_DAYS = 30
const DAY_MS = 24 * 3600_000
export const FREE_BOARD_LIMIT = 200
export const PREMIUM_BOARD_LIMIT = 2000
export const CREATES_PER_MINUTE = 30
const RATE_WINDOW_MS = 60_000
/** A permanent delete's body is `{ confirm }`: never read more than this. */
export const MAX_DELETE_BODY = 4096
/** Past this many users with counters, the idle ones are swept. */
const SWEEP_AT = 10_000

export const TOO_MANY_CREATES = 'Too many new boards. Wait a minute and try again.'

const limitReached = (limit: number, premium: boolean): ApiResult => ({
  status: 403,
  body: { error: premium ? `Board limit reached (${limit}). Move some to the trash.` : `Board limit reached (${limit}). Move some to the trash or ask for premium.` }
})

// The board limits and the create rate.

const createsBy = new Map<string, number[]>()

/** Tests only: forget the create counters. */
export function resetCreateRate(): void {
  createsBy.clear()
}

function recentCreates(userId: string, now: number): number[] {
  const kept = (createsBy.get(userId) ?? []).filter(t => now - t < RATE_WINDOW_MS)
  if (kept.length > 0) createsBy.set(userId, kept)
  else createsBy.delete(userId)
  return kept
}

/** The 403 for an account at its board limit (boards not in the trash), or null. */
function capRefusal(db: Db, who: Who): ApiResult | null {
  if (who.kind !== 'user') return null
  const limit = who.isPremium ? PREMIUM_BOARD_LIMIT : FREE_BOARD_LIMIT
  const n = db.select({ n: count() }).from(boards).where(and(eq(boards.ownerId, who.userId), isNull(boards.trashedAt))).get()?.n ?? 0
  return n >= limit ? limitReached(limit, who.isPremium) : null
}

/** Before a create's body is read: the 403 (board limit) or 429 (create rate) to answer with, or null. */
export function createRefusal(db: Db, who: Who, now = Date.now()): ApiResult | null {
  if (who.kind !== 'user') return null
  if (recentCreates(who.userId, now).length >= CREATES_PER_MINUTE) return { status: 429, body: { error: TOO_MANY_CREATES } }
  return capRefusal(db, who)
}

/** Make a board with `make` unless a limit refuses; only a made board (200) counts toward the rate. */
export function withCreateLimit(db: Db, who: Who, make: () => ApiResult, now = Date.now()): ApiResult {
  const refused = createRefusal(db, who, now)
  if (refused) return refused
  const r = make()
  if (r.status === 200 && who.kind === 'user') {
    if (createsBy.size > SWEEP_AT) for (const id of [...createsBy.keys()]) recentCreates(id, now)
    createsBy.set(who.userId, [...recentCreates(who.userId, now), now])
  }
  return r
}

// Fork and duplicate.

/**
 * `POST /api/boards/:key/fork`: a new board of the signed-in asker's, at the source's current
 * board (live edits not yet committed included), with one `fork` revision and no history. On
 * the asker's own board it is a duplicate named `<name> (copy)`. Needs view.
 */
export function fork(db: Db, req: BoardRequest, now = Date.now()): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const who = req.who
    if (who.kind === 'anonymous') return { status: 403, body: { error: 'Sign in to fork.' } }
    const source = getBoard(db, a.boardId)
    if (!source) return notFound()
    return withCreateLimit(db, who, () => {
      const own = getBoardRow(db, a.boardId)?.ownerId === who.userId
      // The live name: a rename still grouping is in the board, not yet in the row.
      const name = source.board.name
      const board = { ...source.board, name: own ? `${name} (copy)` : name }
      const { id } = createBoard(db, board, 'fork', who.author, who.userId, who.userId, { summary: `forked from ${name}`, forkedFrom: a.boardId })
      return { status: 200, body: { id } }
    }, now)
  })
}

// The trash.

/** `POST /api/boards/:id/trash`: owner only. Its links are 404 from now on; non-owner peers are closed. */
export function trashBoard(db: Db, req: BoardRequest, now = Date.now()): ApiResult {
  return withOwner(db, req, (a) => {
    // Trashed again: the 30 days still count from the first time.
    db.update(boards).set({ trashedAt: now }).where(and(eq(boards.id, a.boardId), isNull(boards.trashedAt))).run()
    kickNonOwnerPeers(a.boardId)
    return { status: 200, body: { trashedAt: getBoardRow(db, a.boardId)!.trashedAt } }
  })
}

/** `POST /api/boards/:id/untrash`: owner only, with its whole history; refused at the board limit. */
export function untrashBoard(db: Db, req: BoardRequest): ApiResult {
  return withOwner(db, req, (a) => {
    if (getBoardRow(db, a.boardId)!.trashedAt !== null) {
      const refused = capRefusal(db, req.who)
      if (refused) return refused
      db.update(boards).set({ trashedAt: null }).where(eq(boards.id, a.boardId)).run()
      kickNonOwnerPeers(a.boardId)
    }
    return { status: 200, body: { trashedAt: null } }
  })
}

/** Rows deleted per statement (SQLite caps a statement's variables). */
const CHUNK = 500

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}

/** Delete boards with their revisions and link visits; their live rooms close first. */
function removeBoards(db: Db, ids: readonly string[]): void {
  for (const id of ids) closeRoom(id)
  db.transaction((tx) => {
    for (const part of chunks(ids)) {
      tx.delete(revisions).where(inArray(revisions.boardId, part)).run()
      tx.delete(linkVisits).where(inArray(linkVisits.boardId, part)).run()
      tx.delete(boards).where(inArray(boards.id, part)).run()
    }
  })
}

/**
 * `DELETE /api/boards/:id` `{ confirm: <the board's name> }`: owner only, a board in the
 * trash only, deleted now with its history. The one immediate delete.
 */
export function deleteBoardForGood(db: Db, req: BoardRequest, text: string): ApiResult {
  return withOwner(db, req, (a) => {
    const row = getBoardRow(db, a.boardId)
    if (!row) return notFound()
    if (row.trashedAt === null) return { status: 409, body: { error: 'Move the board to the trash first.' } }
    const p = parseBody(text)
    if (!p.ok) return p.result
    if (p.json.confirm !== row.name) return invalid(`confirm: must be the board's name exactly, "${row.name}", to delete it for good`)
    removeBoards(db, [row.id])
    return { status: 200, body: { ok: true } }
  })
}

// Accounts.

/**
 * `DELETE /api/me`: the account is deleted, restorable for 30 days. Its links are 404 at
 * once, and live peers on its boards (and its own, anywhere) are closed. False for the local
 * user (who has no deletion) or no such user. Deleted again: the first date stays.
 */
export function deleteAccount(db: Db, userId: string, now = Date.now()): boolean {
  if (userId === 'local') return false
  const changed = db.update(users).set({ deletedAt: now }).where(and(eq(users.id, userId), isNull(users.deletedAt))).run().changes === 1
  if (changed) {
    const owned = db.select({ id: boards.id }).from(boards).where(eq(boards.ownerId, userId)).all()
    kickAccount(userId, new Set(owned.map(b => b.id)))
  }
  return changed || db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get() !== undefined
}

/** `POST /api/me/restore`: a deleted, not yet purged account comes back as it was. False if it was not deleted. */
export function restoreAccount(db: Db, userId: string): boolean {
  return db.update(users).set({ deletedAt: null }).where(and(eq(users.id, userId), isNotNull(users.deletedAt))).run().changes === 1
}

/**
 * Delete what is due at `now`: boards trashed more than TRASH_DAYS ago, and accounts deleted
 * more than TRASH_DAYS ago with all their boards, identities (so the same provider account
 * can sign up again) and link visits. Revisions go with their board. Nothing else.
 */
export function purge(db: Db, now = Date.now()): { boards: number, users: number } {
  const cutoff = now - TRASH_DAYS * DAY_MS
  const dueUsers = db.select({ id: users.id }).from(users)
    .where(and(isNotNull(users.deletedAt), lt(users.deletedAt, cutoff), ne(users.id, 'local'))).all().map(u => u.id)
  const dueBoards = new Set(db.select({ id: boards.id }).from(boards)
    .where(and(isNotNull(boards.trashedAt), lt(boards.trashedAt, cutoff))).all().map(b => b.id))
  for (const part of chunks(dueUsers)) {
    for (const b of db.select({ id: boards.id }).from(boards).where(inArray(boards.ownerId, part)).all()) dueBoards.add(b.id)
  }
  removeBoards(db, [...dueBoards])
  db.transaction((tx) => {
    for (const part of chunks(dueUsers)) {
      tx.delete(identities).where(inArray(identities.userId, part)).run()
      tx.delete(linkVisits).where(inArray(linkVisits.userId, part)).run()
      tx.delete(users).where(inArray(users.id, part)).run()
    }
  })
  return { boards: dueBoards.size, users: dueUsers.length }
}

export const PURGE_EVERY_MS = DAY_MS

type PurgeResult = ReturnType<typeof purge>

/**
 * Purge now and then every PURGE_EVERY_MS. The timer never keeps the process alive. A failed
 * run is logged and the next one tries again. Call the result to stop on shutdown.
 */
export function schedulePurge(db: Db, opts: { log?: (r: PurgeResult) => void } = {}): (() => void) & { timer: ReturnType<typeof setInterval> } {
  const run = () => {
    try {
      opts.log?.(purge(db, Date.now()))
    } catch (e) {
      console.error('[wirebender] purge failed', e)
    }
  }
  run()
  const timer = setInterval(run, PURGE_EVERY_MS)
  timer.unref()
  return Object.assign(() => clearInterval(timer), { timer })
}
