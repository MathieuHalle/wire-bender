// Who is asking (spec §3). In local mode the machine itself and paired devices are the
// local user (server/utils/access.ts decides); in public mode only a signed-in session is
// someone, and loopback or a device cookie means nothing. The session holds only the
// user's id: everything else is read from the database on every call, so a rename,
// suspension or deletion counts at once.
import { eq } from 'drizzle-orm'
import { useDb, type Db } from '../db'
import { users } from '../db/schema'
import { cookieOf, trust, type TrustSource } from './access'
import { checkMode, type Mode } from './mode'

export type Who
  = | { kind: 'local', userId: 'local', author: string, device?: { id: string, name: string } }
    | { kind: 'user', userId: string, author: string, isAdmin: boolean, isPremium: boolean }
    | { kind: 'anonymous' }

/** What the session cookie holds: the user's id only, R1's flag, and the link ids whose password was entered. */
export interface SessionData { user?: { id?: unknown }, pendingDeletion?: boolean, unlocked?: unknown }

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
}

/** Who a request or socket is, with the account behind the session. */
export async function resolveSession(source: TrustSource, deps: WhoDeps = {}): Promise<SessionState> {
  const mode = deps.mode ?? checkMode()
  const db = deps.db ?? useDb()
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
 * gets none: each device names itself (`Local · <device>`).
 */
export function presenceOf(db: Db, who: Who): { name: string, avatar?: string } | undefined {
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
 * The share link ids whose password this request's session has entered (any mode, signed in
 * or not); none without a session cookie, so nothing is read or sealed for a cookieless visitor.
 */
export async function unlockedOf(source: TrustSource, deps: WhoDeps = {}): Promise<string[]> {
  if (cookieOf(source, deps.sessionCookie ?? sessionCookieName()) === undefined) return []
  const list = (await (deps.readSession ?? defaultRead)(source)).unlocked
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}
