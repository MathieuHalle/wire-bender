import { useDb } from '../../../db'
import { unlockLink, withUnlocked } from '../../../utils/boardAccess'
import { checkMode } from '../../../utils/mode'
import { remoteOf } from '../../../utils/peerAddress'
import { readCapped } from '../../../utils/readCapped'

const MAX_BODY = 4096

function parse(text: string): { password?: unknown } | null {
  try {
    const json: unknown = JSON.parse(text)
    return typeof json === 'object' && json !== null ? json as { password?: unknown } : null
  } catch {
    return null
  }
}

/**
 * `POST /api/links/:linkId/unlock` `{ password }`: anyone may try, signed in or not. The
 * right password adds the link's unlock entry (unlockEntry, ruling R5) to the session's `unlocked` list, which creates a session
 * for an anonymous visitor (the one place one gets a cookie). Local mode: 404.
 */
export default defineEventHandler(async (event) => {
  // Local mode has no share links to unlock, and never touches a session.
  if (checkMode() === 'local') {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  const linkId = getRouterParam(event, 'linkId') ?? ''
  // Anyone may call this: never buffer more than a few KB of it.
  const req = event.node.req
  const text = Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY ? null : await readCapped(req, MAX_BODY)
  if (text === null) {
    setResponseStatus(event, 413)
    setResponseHeader(event, 'connection', 'close')
    return { error: 'body too large' }
  }
  const r = await unlockLink(useDb(), linkId, parse(text)?.password, remoteOf(req).address, verifyPassword)
  setResponseStatus(event, r.status)
  if (r.status === 200 && r.entry !== null) {
    // Replaced, not merged: nuxt-auth-utils' merge would concatenate the list.
    const { id: _id, ...data } = await getUserSession(event)
    await replaceUserSession(event, { ...data, unlocked: withUnlocked((data as { unlocked?: unknown }).unlocked, r.entry) })
  }
  return r.body
})
