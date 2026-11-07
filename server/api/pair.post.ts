import { completePairing } from '../utils/access'
import { remoteOf } from '../utils/peerAddress'

const MAX_BODY = 4096
const ERRORS = { 400: 'Wrong or expired code.', 429: 'Too many wrong codes. Wait 10 minutes and try again.' } as const

/** `POST /api/pair` `{ code, name }`: the one API call an unpaired device may make. */
export default defineEventHandler(async (event) => {
  // Anyone on the network may call this: refuse big bodies before reading them.
  if (Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY) {
    setResponseStatus(event, 413)
    return { error: 'body too large' }
  }
  const body = await readBody<{ code?: unknown, name?: unknown }>(event).catch(() => null)
  const r = completePairing(body?.code, body?.name, remoteOf(event.node.req).address)
  if (!r.ok) {
    setResponseStatus(event, r.status)
    return { error: ERRORS[r.status] }
  }
  appendResponseHeader(event, 'set-cookie', r.cookie)
  return { name: r.name }
})
