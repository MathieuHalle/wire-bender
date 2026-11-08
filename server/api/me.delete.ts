import { useDb } from '../db'
import { ONLY_ADMIN, isOnlyAdmin } from '../utils/accounts'
import { deleteAccount } from '../utils/lifecycle'
import { checkMode } from '../utils/mode'
import { resolveSession } from '../utils/who'
import { refuseToken } from '../utils/sendResult'

/**
 * `DELETE /api/me`: delete the signed-in account (restorable for 30 days) and sign out.
 * Local mode has no account to delete: 404. The only active admin can't (409, R13): purge
 * would leave the server with no admin, and setup never opens again.
 */
export default defineEventHandler(async (event) => {
  const refused = refuseToken(event)
  if (refused) return refused
  setResponseHeader(event, 'cache-control', 'no-store')
  const mode = checkMode()
  if (mode === 'local') {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  const state = await resolveSession(event, { mode })
  if (state.who.kind !== 'user') {
    setResponseStatus(event, 401)
    return { error: 'Sign in first.' }
  }
  if (isOnlyAdmin(useDb(), state.who.userId)) {
    setResponseStatus(event, 409)
    return { error: ONLY_ADMIN }
  }
  deleteAccount(useDb(), state.who.userId)
  await clearUserSession(event)
  return { ok: true }
})
