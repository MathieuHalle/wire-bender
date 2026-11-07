import { completePairing } from '../utils/access'
import { remoteOf } from '../utils/peerAddress'
import { readCapped } from '../utils/readCapped'

const MAX_BODY = 4096
const ERRORS = { 400: 'Wrong or expired code, or a device name that cannot be used.', 429: 'Too many wrong codes. Wait 10 minutes and try again.' } as const

function parse(text: string): { code?: unknown, name?: unknown } | null {
  try {
    const json: unknown = JSON.parse(text)
    return typeof json === 'object' && json !== null ? json as { code?: unknown, name?: unknown } : null
  } catch {
    return null
  }
}

/** `POST /api/pair` `{ code, name }`: the one API call an unpaired device may make. */
export default defineEventHandler(async (event) => {
  // Anyone on the network may call this: never buffer more than a few KB of it.
  const req = event.node.req
  const text = Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY ? null : await readCapped(req, MAX_BODY)
  if (text === null) {
    setResponseStatus(event, 413)
    // The rest of the body is never read; the connection closes after this answer.
    setResponseHeader(event, 'connection', 'close')
    return { error: 'body too large' }
  }
  const body = parse(text)
  const r = completePairing(body?.code, body?.name, remoteOf(req).address)
  if (!r.ok) {
    setResponseStatus(event, r.status)
    return { error: ERRORS[r.status] }
  }
  appendResponseHeader(event, 'set-cookie', r.cookie)
  return { name: r.name }
})
