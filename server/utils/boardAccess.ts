// Who may do what with a board (spec §5). A board is reached by its board id, which only
// its owner may use, or by its share link id, with the role the owner's setting gives.
// Everything else (an unknown key, someone else's board id, a private, trashed or
// orphaned link) is the same 404, so a key tells a stranger nothing.
//
// Wrong link-password counters live in memory; a restart drops them.
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { linkVisits, users } from '../db/schema'
import { getBoardByLink, getBoardRow } from './boards'
import type { Who } from './who'

export type Role = 'owner' | 'edit' | 'view'

export type Access
  = | { ok: true, boardId: string, role: Role, signInToEdit: boolean, viaLink: boolean }
    | { ok: false, status: 401 | 404 }

const RANK: Record<Role, number> = { view: 0, edit: 1, owner: 2 }

/** True when `role` may do what `need` may. */
export const allows = (role: Role, need: Role): boolean => RANK[role] >= RANK[need]

const NOT_FOUND = { ok: false, status: 404 } as const

const userIdOf = (who: Who): string | null => who.kind === 'anonymous' ? null : who.userId

/** True when the user exists and has not asked for their account to be deleted. */
function ownerActive(db: Db, ownerId: string): boolean {
  const row = db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, ownerId)).get()
  return row !== undefined && row.deletedAt === null
}

/**
 * A session's unlock of a link (ruling R5): the link id and a short tag of the password
 * hash it was entered for, so a new or removed password, or a new link id, voids it. The
 * tag is a digest of the hash, never part of it.
 */
export function unlockEntry(linkId: string, passwordHash: string): string {
  return `${linkId}:${createHash('sha256').update(passwordHash).digest('base64url').slice(0, 12)}`
}

/** The link id an unlock entry is for (link ids hold no colon). */
function entryLink(entry: string): string {
  const at = entry.lastIndexOf(':')
  return at < 0 ? entry : entry.slice(0, at)
}

/**
 * What `who` may do with the board `key` names. `unlocked` is the session's list of
 * unlock entries (unlockEntry) for the link passwords it has entered.
 */
export function access(db: Db, who: Who, key: string, unlocked: readonly string[]): Access {
  const userId = userIdOf(who)
  const byId = getBoardRow(db, key)
  if (byId) {
    // The owner reaches their own board by id, trashed or not; nobody else ever does.
    return userId !== null && byId.ownerId === userId
      ? { ok: true, boardId: byId.id, role: 'owner', signInToEdit: false, viaLink: false }
      : NOT_FOUND
  }
  const row = getBoardByLink(db, key)
  if (!row || row.trashedAt !== null || row.visibility === 'private' || !ownerActive(db, row.ownerId)) return NOT_FOUND
  if (row.passwordHash !== null && !unlocked.includes(unlockEntry(key, row.passwordHash))) return { ok: false, status: 401 }
  const anonymousEdit = row.visibility === 'edit' && userId === null
  return { ok: true, boardId: row.id, role: anonymousEdit ? 'view' : row.visibility, signInToEdit: anonymousEdit, viaLink: true }
}

/** A signed-in non-owner who opens a board by link: remember it for their "Shared with me" list. */
export function recordVisit(db: Db, who: Who, a: Access & { ok: true }, linkId: string, now = Date.now()): void {
  if (who.kind !== 'user' || !a.viaLink) return
  if (getBoardRow(db, a.boardId)?.ownerId === who.userId) return
  db.insert(linkVisits).values({ userId: who.userId, boardId: a.boardId, linkId, lastOpened: now })
    .onConflictDoUpdate({ target: [linkVisits.userId, linkVisits.boardId], set: { linkId: sql`excluded.link_id`, lastOpened: sql`excluded.last_opened` } })
    .run()
}

/** The display name of a board's owner. */
export function ownerName(db: Db, boardId: string): string {
  const ownerId = getBoardRow(db, boardId)?.ownerId
  if (ownerId === undefined) return ''
  return db.select({ name: users.name }).from(users).where(eq(users.id, ownerId)).get()?.name ?? ''
}

// Link passwords.

/** Wrong passwords per link id and address in UNLOCK_WINDOW_MS before 429 (Global Constraints). */
export const MAX_WRONG_UNLOCKS = 5
export const UNLOCK_WINDOW_MS = 10 * 60_000
/** Link ids a session keeps unlocked; the oldest goes first. */
export const MAX_UNLOCKED = 50
/** Past this many counters, expired ones are swept. */
const SWEEP_AT = 10_000

const wrongBy = new Map<string, { count: number, since: number }>()

/** Tests only: forget the wrong-password counters. */
export function resetUnlocks(): void {
  wrongBy.clear()
}

export type UnlockResult
  = | { status: 200, body: { ok: true }, entry: string | null }
    | { status: 403 | 404 | 429, body: { error: string } }

/**
 * `POST /api/links/:linkId/unlock`: check a link's password. `entry` is what the route adds
 * to the session's list: tagged with the hash the password was checked against, so a
 * change made meanwhile leaves it void. A link without a password needs none (null).
 */
export async function unlockLink(
  db: Db, linkId: string, password: unknown, address: string | undefined,
  verify: (hash: string, plain: string) => Promise<boolean>, now = Date.now()
): Promise<UnlockResult> {
  const row = getBoardByLink(db, linkId)
  if (!row || row.trashedAt !== null || row.visibility === 'private' || !ownerActive(db, row.ownerId)) return { status: 404, body: { error: 'not found' } }
  if (row.passwordHash === null) return { status: 200, body: { ok: true }, entry: null }

  if (wrongBy.size > SWEEP_AT) {
    for (const [k, w] of wrongBy) if (now - w.since > UNLOCK_WINDOW_MS) wrongBy.delete(k)
  }
  const key = `${linkId}\n${address ?? 'unknown'}`
  const seen = wrongBy.get(key)
  if (seen && now - seen.since > UNLOCK_WINDOW_MS) wrongBy.delete(key)
  if ((wrongBy.get(key)?.count ?? 0) >= MAX_WRONG_UNLOCKS) return { status: 429, body: { error: 'Too many wrong passwords. Wait 10 minutes and try again.' } }
  // Counted as wrong before the (async) check, so tries sent in parallel all count.
  const w = wrongBy.get(key) ?? { count: 0, since: now }
  w.count++
  wrongBy.set(key, w)

  let right = false
  if (typeof password === 'string' && password !== '') {
    try {
      right = await verify(row.passwordHash, password)
    } catch {
      right = false
    }
  }
  if (!right) return { status: 403, body: { error: 'Wrong password.' } }
  wrongBy.delete(key)
  return { status: 200, body: { ok: true }, entry: unlockEntry(linkId, row.passwordHash) }
}

/**
 * The session's unlocked list with `entry` added last, at most MAX_UNLOCKED: an older entry
 * for the same link (a void one, or a repeat) goes.
 */
export function withUnlocked(list: unknown, entry: string): string[] {
  const link = entryLink(entry)
  const kept = (Array.isArray(list) ? list : []).filter((x): x is string => typeof x === 'string' && entryLink(x) !== link)
  return [...kept, entry].slice(-MAX_UNLOCKED)
}
