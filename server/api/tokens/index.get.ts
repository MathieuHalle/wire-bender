import { useDb } from '../../db'
import { listTokens } from '../../utils/tokens'
import { whoIs } from '../../utils/who'

/** `GET /api/tokens`: the signed-in user's tokens (the local user's in local mode), newest first. Never a token or its hash. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const who = await whoIs(event)
  if (who.kind === 'anonymous') {
    setResponseStatus(event, 401)
    return { error: 'Sign in first.' }
  }
  return listTokens(useDb(), who.userId)
})
