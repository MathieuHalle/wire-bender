import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { users } from '../../db/schema'
import { meBody } from '../../utils/accounts'
import { restoreSession } from '../../utils/lifecycle'
import { checkMode, configuredProviders } from '../../utils/mode'
import { resolveSession, unlockedOf } from '../../utils/who'

/**
 * `POST /api/me/restore`: a deleted, not yet purged account signed in again (its session is
 * flagged pendingDeletion, ruling R1) comes back, and the flag leaves the session. Answers
 * like `GET /api/me`. Local mode has no accounts: 404.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const mode = checkMode()
  if (mode === 'local') {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  const db = useDb()
  const state = await resolveSession(event, { mode })
  // Already restored (from another tab): nothing to do.
  if (state.who.kind === 'user') return meBody(db, mode, state, configuredProviders())
  const r = restoreSession(db, state)
  if (r.kind !== 'restored') {
    // Gone (purged meanwhile): the session names no one, so it goes.
    if (r.kind === 'gone') await clearUserSession(event)
    setResponseStatus(event, 401)
    return { error: 'Sign in first.' }
  }
  // Replaced, not merged: R1's flag goes; the share links already unlocked stay.
  const unlocked = await unlockedOf(event)
  await replaceUserSession(event, unlocked.length > 0 ? { user: { id: r.userId }, unlocked } : { user: { id: r.userId } })
  const account = db.select().from(users).where(eq(users.id, r.userId)).get()!
  const who = { kind: 'user' as const, userId: account.id, author: account.name, isAdmin: account.isAdmin === 1, isPremium: account.isPremium === 1 }
  return meBody(db, mode, { who, account, pendingDeletion: false }, configuredProviders())
})
