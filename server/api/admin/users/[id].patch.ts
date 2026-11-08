import { useDb } from '../../../db'
import { patchAccount } from '../../../utils/accounts'
import { checkMode } from '../../../utils/mode'
import { readCapped } from '../../../utils/readCapped'
import { whoIs } from '../../../utils/who'

const MAX_BODY = 4096

/**
 * `PATCH /api/admin/users/:id` `{ premium?, suspended? }` (public mode, the admin only;
 * anyone else gets the plain 404 before the body is read). An admin can't suspend
 * themselves (400). Suspending closes the account's live sockets.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const mode = checkMode()
  const who = mode === 'public' ? await whoIs(event, { mode }) : null
  if (who?.kind !== 'user' || !who.isAdmin) {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  const text = Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY ? null : await readCapped(event.node.req, MAX_BODY)
  if (text === null) {
    setResponseStatus(event, 413)
    return { error: 'body too large' }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const r = patchAccount(useDb(), who.userId, getRouterParam(event, 'id') ?? '', body)
  setResponseStatus(event, r.status)
  return r.body
})
