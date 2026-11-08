import { useDb } from '../db'
import { deleteAccount } from '../utils/lifecycle'
import { checkMode } from '../utils/mode'
import { resolveSession } from '../utils/who'

/**
 * `DELETE /api/me`: delete the signed-in account (restorable for 30 days) and sign out.
 * Local mode has no account to delete: 404.
 */
export default defineEventHandler(async (event) => {
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
  deleteAccount(useDb(), state.who.userId)
  await clearUserSession(event)
  return { ok: true }
})
