// Accounts (spec §4): a user signs in with GitHub or Google. An identity (provider and
// the provider's id for that person) belongs to one user. A new identity makes a new user,
// unless it is linked from a signed-in session: it is never joined to an account by email
// or name (Review Focus 4).
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { IDENTITY_PROVIDERS, identities, users } from '../db/schema'
import type { Mode } from './mode'
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
