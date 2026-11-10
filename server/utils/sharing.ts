// A board's sharing (spec §5): its visibility, link password and link id, set by the owner
// only, by board id. Everyone else gets the same 404 as an unknown board. Sharing exists in
// public mode only: the link is `<WIREBENDER_URL>/b/<linkId>`, and with no such address
// (local mode) the routes are 404.
//
// Premium (Global Constraints): only a premium account may make a board private or set a
// link password. Losing premium keeps what exists; lowering visibility or removing the
// password is always allowed.
//
// Any change closes the board's link peers (kickLinkPeers), and a new password or link id
// voids every session's unlock of the old one (ruling R5: unlockEntry).
import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db'
import { BOARD_VISIBILITY, boards, linkVisits, users, type BoardVisibility } from '../db/schema'
import { invalid, notFound, ownerRefusal, parseBody, withOwner, type ApiResult, type BoardRequest } from './api'
import { getBoardRow } from './boards'
import { accountsHere, kickLinkPeers } from './rooms'
import type { Who } from './who'

export const PREMIUM_NEEDED = 'Premium is needed for private boards and link passwords.'
export const MIN_PASSWORD = 4
export const MAX_PASSWORD = 100
/** A sharing PATCH is a few fields: never read more than this. */
export const MAX_SHARING_BODY = 4096

/**
 * A signed-in person who opened the board through its link: `current` while their visit was
 * through today's link (a regenerate leaves them on the old one), `here` while they are on
 * the board live. Deleted and suspended accounts are left out.
 */
export interface SharingPerson { name: string, lastOpened: number, current: boolean, here: boolean }

export interface Sharing { visibility: BoardVisibility, hasPassword: boolean, link: string, canUsePremium: boolean, people: SharingPerson[] }

export interface SharingDeps {
  /** `WIREBENDER_URL`; null in local mode, where sharing is not offered. */
  base: string | null
  /** nuxt-auth-utils' hashPassword in the route. */
  hash: (plain: string) => Promise<string>
  /** utils/sealed.ts' seal with the session secret's key, so the owner can see the password again. */
  seal: (plain: string) => string
}

/** The local user is premium; in public mode the account's flag, read fresh per request. */
export const canUsePremium = (who: Who): boolean => who.kind === 'local' || (who.kind === 'user' && who.isPremium)

const linkOf = (base: string, linkId: string): string => `${base.replace(/\/+$/, '')}/b/${linkId}`

function sharingOf(db: Db, boardId: string, who: Who, base: string): ApiResult {
  const row = getBoardRow(db, boardId)
  if (!row) return notFound()
  const body: Sharing = { visibility: row.visibility, hasPassword: row.passwordHash !== null, link: linkOf(base, row.linkId), canUsePremium: canUsePremium(who), people: peopleOf(db, boardId, row.linkId) }
  return { status: 200, body }
}

function peopleOf(db: Db, boardId: string, linkId: string): SharingPerson[] {
  const here = accountsHere(boardId)
  return db.select({ userId: linkVisits.userId, name: users.name, linkId: linkVisits.linkId, lastOpened: linkVisits.lastOpened })
    .from(linkVisits)
    .innerJoin(users, eq(users.id, linkVisits.userId))
    .where(and(eq(linkVisits.boardId, boardId), isNull(users.deletedAt), isNull(users.suspendedAt)))
    .orderBy(desc(linkVisits.lastOpened))
    .all()
    .map(v => ({ name: v.name, lastOpened: v.lastOpened, current: v.linkId === linkId, here: here.has(v.userId) }))
}

/** Before a sharing write's body is read: its refusal (not the owner, or no sharing here), or null. */
export function sharingRefusal(db: Db, req: BoardRequest, base: string | null): ApiResult | null {
  return base === null ? notFound() : ownerRefusal(db, req)
}

/** `GET /api/boards/:id/sharing`. */
export function getSharing(db: Db, req: BoardRequest, base: string | null): ApiResult {
  if (base === null) return notFound()
  return withOwner(db, req, a => sharingOf(db, a.boardId, req.who, base))
}

type Change = { visibility?: BoardVisibility, password?: string | null }

/** The change a PATCH body asks for, or the 422 to answer with. */
function changeOf(json: Record<string, unknown>): { ok: true, change: Change } | { ok: false, result: ApiResult } {
  const change: Change = {}
  const errors: string[] = []
  if ('visibility' in json) {
    if (BOARD_VISIBILITY.includes(json.visibility as BoardVisibility)) change.visibility = json.visibility as BoardVisibility
    else errors.push(`visibility: must be one of ${BOARD_VISIBILITY.join(', ')}`)
  }
  if ('password' in json) {
    const p = json.password
    // Counted in code points, so an emoji is one character.
    const length = typeof p === 'string' ? [...p].length : -1
    if (p === null || (length >= MIN_PASSWORD && length <= MAX_PASSWORD)) change.password = p as string | null
    else errors.push(`password: must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters, or null to remove it`)
  }
  return errors.length > 0 ? { ok: false, result: invalid(...errors) } : { ok: true, change }
}

/** `PATCH /api/boards/:id/sharing` `{ visibility?, password?: string | null }`; answers with the new settings. */
export async function patchSharing(db: Db, req: BoardRequest, text: string, deps: SharingDeps): Promise<ApiResult> {
  const { base } = deps
  if (base === null) return notFound()
  return await withOwner(db, req, async (a) => {
    const p = parseBody(text)
    if (!p.ok) return p.result
    const c = changeOf(p.json)
    if (!c.ok) return c.result
    const { visibility, password } = c.change
    const before = getBoardRow(db, a.boardId)
    if (!before) return notFound()
    const premiumAsked = (visibility === 'private' && before.visibility !== 'private') || typeof password === 'string'
    if (premiumAsked && !canUsePremium(req.who)) return { status: 403, body: { error: PREMIUM_NEEDED } }

    const passwordHash = typeof password === 'string' ? await deps.hash(password) : password
    const passwordSealed = typeof password === 'string' ? deps.seal(password) : password
    // Read again after the (slow) hash: compare with what is stored now.
    const now = getBoardRow(db, a.boardId)
    if (!now) return notFound()
    const set: Partial<typeof boards.$inferInsert> = {}
    if (visibility !== undefined && visibility !== now.visibility) set.visibility = visibility
    if (passwordHash !== undefined && (passwordHash !== null || now.passwordHash !== null)) {
      set.passwordHash = passwordHash
      set.passwordSealed = passwordSealed
    }
    if (Object.keys(set).length > 0) {
      db.update(boards).set(set).where(eq(boards.id, a.boardId)).run()
      kickLinkPeers(a.boardId)
    }
    return sharingOf(db, a.boardId, req.who, base)
  })
}

/**
 * `GET /api/boards/:id/sharing/password`: the link password for its owner, `{ password }`.
 * `password` is null with no password, and also when it cannot be shown: set before it was
 * kept, or kept under another session secret. Setting it again makes it showable.
 */
export function getSharingPassword(db: Db, req: BoardRequest, base: string | null, unseal: (sealed: string) => string | null): ApiResult {
  if (base === null) return notFound()
  return withOwner(db, req, (a) => {
    const row = getBoardRow(db, a.boardId)
    if (!row) return notFound()
    const password = row.passwordHash !== null && row.passwordSealed !== null ? unseal(row.passwordSealed) : null
    return { status: 200, body: { password } }
  })
}

/** `POST /api/boards/:id/sharing/regenerate`: a new link id; the old link is 404 from now on. */
export function regenerateLink(db: Db, req: BoardRequest, base: string | null): ApiResult {
  if (base === null) return notFound()
  return withOwner(db, req, (a) => {
    const linkId = randomUUID()
    db.update(boards).set({ linkId }).where(eq(boards.id, a.boardId)).run()
    kickLinkPeers(a.boardId)
    return { status: 200, body: { link: linkOf(base, linkId) } }
  })
}
