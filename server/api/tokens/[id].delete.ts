import { useDb } from '../../db'
import { revokeToken } from '../../utils/tokens'
import { tokenManager } from '../../utils/sendResult'

/** `DELETE /api/tokens/:id`: revoke one of your own tokens. 204, or 404 if it is not yours. */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const who = tokenManager(event)
  if (!who.ok) return who.body
  if (!revokeToken(useDb(), who.userId, getRouterParam(event, 'id') ?? '')) {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  setResponseStatus(event, 204)
  return null
})
