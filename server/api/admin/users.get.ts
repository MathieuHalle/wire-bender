import { useDb } from '../../db'
import { listAccounts } from '../../utils/accounts'
import { checkMode } from '../../utils/mode'
import { whoIs } from '../../utils/who'
import { refuseToken } from '../../utils/sendResult'

/**
 * `GET /api/admin/users`: every account, newest first (public mode, the admin only). For
 * anyone else, and in local mode, the plain 404 of an unknown route.
 */
export default defineEventHandler(async (event) => {
  const refused = refuseToken(event)
  if (refused) return refused
  setResponseHeader(event, 'cache-control', 'no-store')
  const mode = checkMode()
  const who = mode === 'public' ? await whoIs(event, { mode }) : null
  if (who?.kind !== 'user' || !who.isAdmin) {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  return listAccounts(useDb())
})
