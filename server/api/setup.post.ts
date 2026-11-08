import { useDb } from '../db'
import { SETUP_DONE, checkSetupCode, claimSetup } from '../utils/accounts'
import { checkMode } from '../utils/mode'
import { remoteOf } from '../utils/peerAddress'
import { readCapped } from '../utils/readCapped'
import { resolveSession } from '../utils/who'
import { refuseToken } from '../utils/sendResult'

const MAX_BODY = 4096

function parse(text: string): { code?: unknown } | null {
  try {
    const json: unknown = JSON.parse(text)
    return typeof json === 'object' && json !== null ? json as { code?: unknown } : null
  } catch {
    return null
  }
}

/**
 * `POST /api/setup` `{ code }` (public mode; anyone may try, wrong tries are limited). The
 * right code from a signed-in account makes it the admin at once (ruling R9, `admin: true`);
 * signed out, the session gets `setupOk` (a tag of this code, R11) and the next sign-in
 * does it, unless a restart has made a new code meanwhile. 410 once an admin
 * exists. Local mode has no setup: 404.
 */
export default defineEventHandler(async (event) => {
  const refused = refuseToken(event)
  if (refused) return refused
  setResponseHeader(event, 'cache-control', 'no-store')
  const mode = checkMode()
  if (mode === 'local') {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  const req = event.node.req
  const text = Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY ? null : await readCapped(req, MAX_BODY)
  if (text === null) {
    setResponseStatus(event, 413)
    setResponseHeader(event, 'connection', 'close')
    return { error: 'body too large' }
  }
  const db = useDb()
  const r = checkSetupCode(db, parse(text)?.code, remoteOf(req).address)
  if (r.status !== 200) {
    setResponseStatus(event, r.status)
    return r.body
  }
  const state = await resolveSession(event, { mode })
  if (state.who.kind === 'user') {
    if (!claimSetup(db, state.who.userId, r.tag).ok) {
      setResponseStatus(event, 410)
      return SETUP_DONE
    }
    return { ok: true, admin: true }
  }
  // Replaced, not merged: nuxt-auth-utils' merge would concatenate lists such as `unlocked`.
  const { id: _id, ...data } = await getUserSession(event)
  await replaceUserSession(event, { ...data, setupOk: r.tag })
  return { ok: true, admin: false }
})
