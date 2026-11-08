// Who is asking (spec §3). In local mode the machine itself and paired devices are the
// local user (server/utils/access.ts decides); in public mode only a signed-in session is
// someone, and loopback or a device cookie means nothing. The session holds only the
// user's id: everything else is read from the database on every call, so a rename,
// suspension or deletion counts at once.
import { eq } from 'drizzle-orm'
import { useDb, type Db } from '../db'
import { users } from '../db/schema'
import { bearerOf, cookieOf, trust, type TrustSource } from './access'
import { checkMode, type Mode } from './mode'
import { tokenByBearer, touchToken } from './tokens'

/** The personal API token a request was made with (never the token string itself). */
export interface WhoToken { id: string, name: string }

/**
 * Who is asking. With `token`, the request was made with that token: `author` is then
 * `<token name> · <user name>` (`<token name> · Local` for the local user).
 */
export type Who
  = | { kind: 'local', userId: 'local', author: string, device?: { id: string, name: string }, token?: WhoToken }
    | { kind: 'user', userId: string, author: string, isAdmin: boolean, isPremium: boolean, token?: WhoToken }
    | { kind: 'anonymous' }

/**
 * What the session cookie holds: the user's id only, R1's flag, the link ids whose password
 * was entered, and `setupOk` once the setup code was entered signed out: a tag of that
 * code (R11); the next sign-in finishes the setup with it and drops it.
 */
export interface SessionData { user?: { id?: unknown }, pendingDeletion?: boolean, unlocked?: unknown, setupOk?: unknown }

export interface WhoDeps {
  mode?: Mode
  db?: Db
  /** The session cookie's name (nuxt-auth-utils: `runtimeConfig.session.name`). */
  sessionCookie?: string
  readSession?: (source: TrustSource) => Promise<SessionData>
  clearSession?: (source: TrustSource) => Promise<void>
}

const ANONYMOUS: Who = { kind: 'anonymous' }

/** The name nuxt-auth-utils keeps its session under (NUXT_SESSION_NAME may change it). */
export function sessionCookieName(): string {
  const name = (useRuntimeConfig().session as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && name !== '' && name !== 'nuxt-session' ? name : 'nuxt-auth-session'
}

/** An h3 event (the only source a session can be written on: sockets can only read it). */
function isEvent(source: TrustSource): boolean {
  return 'node' in source
}

const defaultRead = async (source: TrustSource): Promise<SessionData> =>
  await getUserSession(source as Parameters<typeof getUserSession>[0]) as SessionData

async function defaultClear(source: TrustSource): Promise<void> {
  if (isEvent(source)) await clearUserSession(source as Parameters<typeof clearUserSession>[0])
}

export interface SessionState {
  who: Who
  /** The session's user row, also when they count as anonymous (a pendingDeletion session, R1). */
  account: typeof users.$inferSelect | null
  /** Signed in as a deleted, not yet purged user: only /account (restore or sign out). */
  pendingDeletion: boolean
  /** The request sent a bearer token that is wrong, revoked or malformed, or whose user is not active: 401 `Invalid token.`. */
  invalidToken?: true
}

export const INVALID_TOKEN = 'Invalid token.'

/** The local user's author name in a token's author (`<token name> · Local`). */
const LOCAL_TOKEN_OWNER = 'Local'

/**
 * Who a bearer token is: its user, if the token exists and that user is active (in local
 * mode, the local user; in public mode, any signed-up user but `local`). Anything else is an
 * invalid token. The use is recorded (at most once a minute).
 */
function tokenState(db: Db, mode: Mode, bearer: string): SessionState {
  const invalid: SessionState = { who: ANONYMOUS, account: null, pendingDeletion: false, invalidToken: true }
  const token = tokenByBearer(db, bearer)
  if (!token) return invalid
  const row = db.select().from(users).where(eq(users.id, token.userId)).get()
  if (!row || row.suspendedAt !== null || row.deletedAt !== null) return invalid
  if ((mode === 'local') !== (row.id === 'local')) return invalid
  // Bookkeeping only: a failed write (a busy or read-only database) never fails the request.
  try {
    touchToken(db, token)
  } catch {
    // The next use tries again.
  }
  const t: WhoToken = { id: token.id, name: token.name }
  const who: Who = mode === 'local'
    ? { kind: 'local', userId: 'local', author: `${t.name} · ${LOCAL_TOKEN_OWNER}`, token: t }
    : { kind: 'user', userId: row.id, author: `${t.name} · ${row.name}`, isAdmin: row.isAdmin === 1, isPremium: row.isPremium === 1, token: t }
  return { who, account: row, pendingDeletion: false }
}

/**
 * Who a source's bearer token is, synchronously (a socket's open checks its token again);
 * null when it sends no bearer header.
 */
export function bearerSession(source: TrustSource, deps: Pick<WhoDeps, 'mode' | 'db'> = {}): SessionState | null {
  const bearer = bearerOf(source)
  return bearer === undefined ? null : tokenState(deps.db ?? useDb(), deps.mode ?? checkMode(), bearer)
}

/** Who a request or socket is, with the account behind the session. */
export async function resolveSession(source: TrustSource, deps: WhoDeps = {}): Promise<SessionState> {
  const mode = deps.mode ?? checkMode()
  const db = deps.db ?? useDb()
  // A bearer header decides the request alone: the cookie (and loopback) are never read.
  const bearer = bearerOf(source)
  if (bearer !== undefined) return tokenState(db, mode, bearer)
  if (mode === 'local') {
    const t = trust(source, db)
    if (!t.ok) return { who: ANONYMOUS, account: null, pendingDeletion: false }
    const who: Who = t.device ? { kind: 'local', userId: 'local', author: t.author, device: t.device } : { kind: 'local', userId: 'local', author: t.author }
    return { who, account: db.select().from(users).where(eq(users.id, 'local')).get() ?? null, pendingDeletion: false }
  }

  // No session cookie, no session: reading one would make and seal an empty session, and
  // send every anonymous visitor (and cookieless CLI or AI client) a Set-Cookie.
  if (cookieOf(source, deps.sessionCookie ?? sessionCookieName()) === undefined) return { who: ANONYMOUS, account: null, pendingDeletion: false }
  const session = await (deps.readSession ?? defaultRead)(source)
  const id = session.user?.id
  if (typeof id !== 'string' || id === '') return { who: ANONYMOUS, account: null, pendingDeletion: false }
  const row = db.select().from(users).where(eq(users.id, id)).get()
  // `local` never signs in: it has no identity, and a session naming it is forged or stale.
  const usable = row && row.id !== 'local' && row.suspendedAt === null
  if (usable && row.deletedAt === null) {
    return { who: { kind: 'user', userId: row.id, author: row.name, isAdmin: row.isAdmin === 1, isPremium: row.isPremium === 1 }, account: row, pendingDeletion: false }
  }
  if (usable && session.pendingDeletion === true) return { who: ANONYMOUS, account: row, pendingDeletion: true }
  await (deps.clearSession ?? defaultClear)(source)
  return { who: ANONYMOUS, account: null, pendingDeletion: false }
}

/** The account a revision by `who` is stored under: the user's id, 'local' for the local user, none for anonymous. */
export const authorIdOf = (who: Who): string | null => who.kind === 'anonymous' ? null : who.userId

/**
 * Who `who` is in a board's presence, stamped by the server over whatever the client says:
 * a signed-in account's name and avatar (read fresh), `Guest` for anonymous. The local user
 * gets none: each device names itself (`Local · <device>`). A request made with a token is
 * the token, by its name, in either mode.
 */
export function presenceOf(db: Db, who: Who): { name: string, avatar?: string, kind?: 'token' } | undefined {
  if (who.kind !== 'anonymous' && who.token) return { name: who.token.name, kind: 'token' }
  if (who.kind === 'local') return undefined
  if (who.kind === 'anonymous') return { name: 'Guest' }
  const row = db.select({ name: users.name, avatar: users.avatar }).from(users).where(eq(users.id, who.userId)).get()
  const name = row?.name ?? who.author
  return row?.avatar ? { name, avatar: row.avatar } : { name }
}

/** Who a request (h3 event), WebSocket upgrade request or WebSocket peer is. */
export async function whoIs(source: TrustSource, deps: WhoDeps = {}): Promise<Who> {
  return (await resolveSession(source, deps)).who
}

/**
 * Whether the session may be read for `source`: public mode only, only with a session
 * cookie, and never for a request made with a token. Local mode reads no session: a cookie a public server on another port of the same
 * host set would be resealed (signing that browser out there), or throw in a build without
 * a secret. Without a cookie nothing is read or sealed for a cookieless visitor.
 */
function sessionReadable(source: TrustSource, deps: WhoDeps): boolean {
  if ((deps.mode ?? checkMode()) === 'local') return false
  if (bearerOf(source) !== undefined) return false
  return cookieOf(source, deps.sessionCookie ?? sessionCookieName()) !== undefined
}

/**
 * The share link ids whose password this request's session has entered (public mode, signed
 * in or not); none in local mode or without a session cookie (sessionReadable).
 */
export async function unlockedOf(source: TrustSource, deps: WhoDeps = {}): Promise<string[]> {
  if (!sessionReadable(source, deps)) return []
  const list = (await (deps.readSession ?? defaultRead)(source)).unlocked
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

/**
 * The tag of the setup code this request's session entered (POST /api/setup) and has not
 * signed in since; null for none (always in local mode). claimSetup checks it against the
 * current code (R11).
 */
export async function setupOkOf(source: TrustSource, deps: WhoDeps = {}): Promise<string | null> {
  if (!sessionReadable(source, deps)) return null
  const tag = (await (deps.readSession ?? defaultRead)(source)).setupOk
  return typeof tag === 'string' && tag !== '' ? tag : null
}
