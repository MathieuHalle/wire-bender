// Accounts (spec §4): a user signs in with GitHub or Google. An identity (provider and
// the provider's id for that person) belongs to one user. A new identity makes a new user,
// unless it is linked from a signed-in session: it is never joined to an account by email
// or name (Review Focus 4).
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, count, desc, eq, isNull, ne } from 'drizzle-orm'
import type { Db } from '../db'
import { IDENTITY_PROVIDERS, boards, identities, setup, users } from '../db/schema'
import type { Mode } from './mode'
import { kickAccount } from './rooms'
import type { SessionState } from './who'

export type Provider = typeof IDENTITY_PROVIDERS[number]

export const PROVIDERS: readonly Provider[] = IDENTITY_PROVIDERS

/** What a provider tells us about the person: its own id for them, a name, maybe an avatar. */
export interface Profile { id: string, name: string, avatar?: string }

/**
 * `deleted`: the account is deleted but not yet purged; the session may only reach
 * /account to restore it or sign out (ruling R1).
 */
export type SignInResult = { ok: true, userId: string, deleted?: true } | { ok: false, reason: 'suspended' | 'taken' }

export const MAX_NAME = 60
const PLACEHOLDER_NAME = 'New user'

/**
 * A name's code points with what can't be shown dropped: control and format characters
 * (zero-width, bidi overrides), line and paragraph separators, lone surrogates. Trimmed.
 * Lengths are counted in these code points, so an emoji counts once.
 */
function nameCodePoints(name: string): string[] {
  return [...name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, '').trim()]
}

/** A display name, cleaned; null unless 1 to 60 code points. */
export function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const points = nameCodePoints(name)
  return points.length >= 1 && points.length <= MAX_NAME ? points.join('') : null
}

/** A provider's name as a display name: cleaned, cut to 60 code points, or a placeholder. Always one `cleanName` accepts. */
function nameFromProvider(name: string): string {
  return cleanName(nameCodePoints(name).slice(0, MAX_NAME).join('')) ?? PLACEHOLDER_NAME
}

/** Only an https avatar URL is kept. */
function avatarUrl(avatar: string | undefined): string | null {
  if (!avatar) return null
  try {
    return new URL(avatar).protocol === 'https:' ? avatar : null
  } catch {
    return null
  }
}

function userRow(db: Pick<Db, 'select'>, id: string) {
  return db.select().from(users).where(eq(users.id, id)).get()
}

/**
 * Sign in with a provider's profile; `current` is the signed-in user, if any (linking).
 * A known identity gives its user; an unknown one is linked to `current`, or makes a new
 * user when signed out. An identity of another user can't be linked (`taken`).
 */
export function signIn(db: Db, provider: Provider, profile: Profile, current?: string, now = Date.now()): SignInResult {
  return db.transaction((tx) => {
    const known = tx.select().from(identities)
      .where(and(eq(identities.provider, provider), eq(identities.providerId, profile.id))).get()
    if (known) {
      if (current !== undefined && current !== known.userId) return { ok: false, reason: 'taken' }
      const user = userRow(tx, known.userId)
      // An identity whose user is gone (never expected: purge removes both) signs in as no one.
      if (!user) return { ok: false, reason: 'taken' }
      if (user.suspendedAt !== null) return { ok: false, reason: 'suspended' }
      if (user.deletedAt !== null) return { ok: true, userId: user.id, deleted: true }
      return { ok: true, userId: user.id }
    }
    if (current !== undefined) {
      const user = userRow(tx, current)
      if (!user) return { ok: false, reason: 'taken' }
      if (user.suspendedAt !== null) return { ok: false, reason: 'suspended' }
      if (user.deletedAt !== null) return { ok: true, userId: user.id, deleted: true }
      tx.insert(identities).values({ provider, providerId: profile.id, userId: current }).run()
      return { ok: true, userId: current }
    }
    const id = randomUUID()
    tx.insert(users).values({ id, name: nameFromProvider(profile.name), avatar: avatarUrl(profile.avatar), createdAt: now }).run()
    tx.insert(identities).values({ provider, providerId: profile.id, userId: id }).run()
    return { ok: true, userId: id }
  })
}

/** The providers a user has linked, in a fixed order. */
export function providersOf(db: Db, userId: string): Provider[] {
  const linked = new Set(db.select({ provider: identities.provider }).from(identities).where(eq(identities.userId, userId)).all().map(r => r.provider))
  return PROVIDERS.filter(p => linked.has(p))
}

export interface Me {
  id: string
  name: string
  avatar: string | null
  isAdmin: boolean
  isPremium: boolean
  providers: Provider[]
  deletedAt: number | null
}

/** A user as `GET /api/me` shows them; null if there is no such user. */
export function me(db: Db, userId: string): Me | null {
  const row = userRow(db, userId)
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    isAdmin: row.isAdmin === 1,
    isPremium: row.isPremium === 1,
    providers: providersOf(db, row.id),
    deletedAt: row.deletedAt
  }
}

/** Sets a user's display name; false (nothing changed) if the name is not 1 to 60 usable chars. */
export function rename(db: Db, userId: string, name: unknown): boolean {
  const clean = cleanName(name)
  if (clean === null) return false
  return db.update(users).set({ name: clean }).where(eq(users.id, userId)).run().changes === 1
}

export interface MeBody {
  mode: Mode
  user: Me | null
  /** The providers one can sign in with here (none in local mode: there is nothing to sign in to). */
  providers: Provider[]
}

/** `GET /api/me`: the mode, who is signed in (a pendingDeletion session too, with deletedAt), and the sign-in providers. */
export function meBody(db: Db, mode: Mode, state: SessionState, configured: Provider[]): MeBody {
  const id = state.who.kind !== 'anonymous' ? state.who.userId : state.pendingDeletion ? state.account?.id : undefined
  return { mode, user: id === undefined ? null : me(db, id), providers: mode === 'public' ? configured : [] }
}

// The first admin (spec §3). A public server with no admin makes a new setup code at every
// start and logs it; only its sha256 is stored. Whoever enters it and then signs in (or is
// signed in already: ruling R9) becomes admin and premium, and takes over the local user's
// boards with their history. The local user is admin too, but never counts here: it can't
// sign in in public mode.
//
// Wrong-code counters live in memory; a restart drops them.

export const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const SETUP_LENGTH = 12

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A code as typed, compared without its dashes (and spaces), in capitals. */
const normalCode = (code: string): string => code.replace(/[\s-]/g, '').toUpperCase()

/** True once an admin exists (anyone but the local user) or the setup was finished. */
export function setupDone(db: Pick<Db, 'select'>): boolean {
  if (db.select({ doneAt: setup.doneAt }).from(setup).all().some(r => r.doneAt !== null)) return true
  return db.select({ id: users.id }).from(users).where(and(eq(users.isAdmin, 1), ne(users.id, 'local'))).get() !== undefined
}

/** A new setup code, `XXXX-XXXX-XXXX`; its sha256 replaces the last one's, which stops working. */
export function newSetupCode(db: Db): string {
  let raw = ''
  for (let i = 0; i < SETUP_LENGTH; i++) raw += SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]
  const codeHash = sha256(raw)
  db.transaction((tx) => {
    if (tx.update(setup).set({ codeHash }).run().changes === 0) tx.insert(setup).values({ codeHash, doneAt: null }).run()
  })
  return raw.match(/.{4}/g)!.join('-')
}

/**
 * At start: in public mode with no admin, a new code and the line to log it with
 * (`base` is WIREBENDER_URL). Null otherwise, and then no code is made.
 */
export function setupNotice(db: Db, mode: Mode, base: string | null): string | null {
  if (mode !== 'public' || base === null || setupDone(db)) return null
  return `[wirebender] setup code: ${newSetupCode(db)} — enter it at ${base.replace(/\/+$/, '')}/setup`
}

/** Wrong setup codes per address in SETUP_WINDOW_MS before 429 (Global Constraints). */
export const MAX_WRONG_SETUP = 5
export const SETUP_WINDOW_MS = 10 * 60_000
/** Past this many counters, expired ones are swept. */
const SWEEP_AT = 10_000
const wrongSetup = new Map<string, { count: number, since: number }>()

/** Tests only: forget the wrong-code counters. */
export function resetSetupTries(): void {
  wrongSetup.clear()
}

export const SETUP_DONE = { error: 'Setup is done.' } as const

export type SetupCheck = { status: 200 } | { status: 403 | 410 | 429, body: { error: string } }

/** `POST /api/setup`: is `code` this start's setup code? 410 once an admin exists; wrong tries are limited per address. */
export function checkSetupCode(db: Db, code: unknown, address: string | undefined, now = Date.now()): SetupCheck {
  if (setupDone(db)) return { status: 410, body: SETUP_DONE }
  if (wrongSetup.size > SWEEP_AT) {
    for (const [k, w] of wrongSetup) if (now - w.since > SETUP_WINDOW_MS) wrongSetup.delete(k)
  }
  const key = address ?? 'unknown'
  const seen = wrongSetup.get(key)
  if (seen && now - seen.since > SETUP_WINDOW_MS) wrongSetup.delete(key)
  if ((wrongSetup.get(key)?.count ?? 0) >= MAX_WRONG_SETUP) return { status: 429, body: { error: 'Too many wrong codes. Wait 10 minutes and try again.' } }
  // Counted as wrong before the check (as the link unlock does), so parallel tries all count.
  const w = wrongSetup.get(key) ?? { count: 0, since: now }
  w.count++
  wrongSetup.set(key, w)

  const stored = db.select({ codeHash: setup.codeHash }).from(setup).all().find(r => r.codeHash !== null)?.codeHash ?? null
  const right = typeof code === 'string' && stored !== null
    && timingSafeEqual(Buffer.from(sha256(normalCode(code)), 'hex'), Buffer.from(stored, 'hex'))
  if (!right) return { status: 403, body: { error: 'Wrong setup code.' } }
  wrongSetup.delete(key)
  return { status: 200 }
}

/**
 * The setup is finished by `userId`, in one transaction: they become admin and premium,
 * every board of the local user becomes theirs (`owner_id` only: the history stays as
 * written, authors and author ids included), and the setup is marked done with no code
 * left. Refused once an admin exists, and for the local user or an unknown, suspended or
 * deleted account.
 *
 * Live rooms of the moved boards are left as they are: in public mode the local user can't
 * sign in, so every peer there came by the share link, and the move changes no link's role.
 */
export function claimSetup(db: Db, userId: string, now = Date.now()): { ok: true, moved: number } | { ok: false } {
  return db.transaction((tx) => {
    if (userId === 'local' || setupDone(tx)) return { ok: false }
    const user = userRow(tx, userId)
    if (!user || user.suspendedAt !== null || user.deletedAt !== null) return { ok: false }
    tx.update(users).set({ isAdmin: 1, isPremium: 1 }).where(eq(users.id, userId)).run()
    const moved = tx.update(boards).set({ ownerId: userId }).where(eq(boards.ownerId, 'local')).run().changes
    if (tx.update(setup).set({ codeHash: null, doneAt: now }).run().changes === 0) tx.insert(setup).values({ codeHash: null, doneAt: now }).run()
    return { ok: true, moved }
  })
}

// Admin (spec §3): the accounts, their premium flag and suspension. Nothing else: the admin
// never sees anyone's boards, only how many each account has.

export interface AccountRow {
  id: string
  name: string
  avatar: string | null
  providers: Provider[]
  /** Boards not in the trash. */
  boards: number
  createdAt: number
  isPremium: boolean
  isAdmin: boolean
  suspendedAt: number | null
  deletedAt: number | null
}

function boardCounts(db: Db): Map<string, number> {
  const rows = db.select({ ownerId: boards.ownerId, n: count() }).from(boards).where(isNull(boards.trashedAt)).groupBy(boards.ownerId).all()
  return new Map(rows.map(r => [r.ownerId, r.n]))
}

function accountRow(db: Db, u: typeof users.$inferSelect, counts: Map<string, number>): AccountRow {
  return {
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    providers: providersOf(db, u.id),
    boards: counts.get(u.id) ?? 0,
    createdAt: u.createdAt,
    isPremium: u.isPremium === 1,
    isAdmin: u.isAdmin === 1,
    suspendedAt: u.suspendedAt,
    deletedAt: u.deletedAt
  }
}

/** `GET /api/admin/users`: every account but the local user, newest first. */
export function listAccounts(db: Db): AccountRow[] {
  const counts = boardCounts(db)
  return db.select().from(users).where(ne(users.id, 'local')).orderBy(desc(users.createdAt), desc(users.id)).all()
    .map(u => accountRow(db, u, counts))
}

export type PatchAccountResult
  = | { status: 200, body: AccountRow }
    | { status: 400 | 404, body: { error: string } }
    | { status: 422, body: { errors: string[] } }

/**
 * `PATCH /api/admin/users/:id` `{ premium?, suspended? }` by the admin `adminId`. Suspending
 * keeps the first date and closes the account's live sockets at once; its sessions count
 * as signed out from their next request (whoIs reads the row every time). An admin can't
 * suspend their own account.
 */
export function patchAccount(db: Db, adminId: string, id: string, body: unknown, now = Date.now()): PatchAccountResult {
  const target = id === 'local' ? undefined : userRow(db, id)
  if (!target) return { status: 404, body: { error: 'not found' } }
  const json = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (!json) return { status: 422, body: { errors: ['the body must be a JSON object'] } }
  const errors: string[] = []
  for (const k of ['premium', 'suspended'] as const) if (k in json && typeof json[k] !== 'boolean') errors.push(`${k}: must be true or false`)
  if (!('premium' in json) && !('suspended' in json)) errors.push('give premium or suspended')
  if (errors.length > 0) return { status: 422, body: { errors } }
  const premium = json.premium as boolean | undefined
  const suspended = json.suspended as boolean | undefined
  if (suspended === true && id === adminId) return { status: 400, body: { error: 'You can\'t suspend your own account.' } }

  db.transaction((tx) => {
    if (premium !== undefined) tx.update(users).set({ isPremium: premium ? 1 : 0 }).where(eq(users.id, id)).run()
    if (suspended === true) tx.update(users).set({ suspendedAt: now }).where(and(eq(users.id, id), isNull(users.suspendedAt))).run()
    if (suspended === false) tx.update(users).set({ suspendedAt: null }).where(eq(users.id, id)).run()
  })
  // Its own sockets, in every room. Its boards' share links keep working, as any owner's.
  if (suspended === true) kickAccount(id, new Set())
  return { status: 200, body: accountRow(db, userRow(db, id)!, boardCounts(db)) }
}
