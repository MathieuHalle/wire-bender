import { useDb } from '../../db'
import { revokeToken } from '../../utils/tokens'
import { whoIs } from '../../utils/who'

/** `DELETE /api/tokens/:id`: revoke one of your own tokens. 204, or 404 if it is not yours. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const who = await whoIs(event)
  if (who.kind === 'anonymous') {
    setResponseStatus(event, 401)
    return { error: 'Sign in first.' }
  }
  if (!revokeToken(useDb(), who.userId, getRouterParam(event, 'id') ?? '')) {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  setResponseStatus(event, 204)
  return null
})
