import { useDb } from '../../db'
import { listTokens } from '../../utils/tokens'
import { tokenManager } from '../../utils/sendResult'

/** `GET /api/tokens`: the signed-in user's tokens (the local user's in local mode), newest first. Never a token or its hash. */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const who = tokenManager(event)
  if (!who.ok) return who.body
  return listTokens(useDb(), who.userId)
})
