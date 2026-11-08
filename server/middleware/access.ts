import type { H3Event } from 'h3'
import { gate, publicGate, refusal, trust } from '../utils/access'
import { cookieSecure, enforceCookieSecure, type CookieRes } from '../utils/cookieSecure'
import { checkMode, type Mode } from '../utils/mode'
import { resolveSession, sessionCookieName, type Who } from '../utils/who'

// Every request. First a request naming another site (DNS rebinding, a cross-site write)
// is refused with 403, whoever sends it. WebSocket upgrades do not pass here; the board
// socket checks them itself, the same way.
//
// Local mode: the machine itself and paired devices pass (their author is kept for the
// API's revisions); others get 401 from the API and the pairing page for pages.
//
// Public mode: who is asking comes from the session alone (never loopback or a device
// cookie). Anonymous visitors may read; writes need a signed-in user (server/utils/access.ts
// `publicGate`); the pairing routes do not exist.
function local(event: H3Event) {
  const t = trust(event)
  if (t.ok) {
    event.context.author = t.author
    event.context.device = t.device
    event.context.who = (t.device
      ? { kind: 'local', userId: 'local', author: t.author, device: t.device }
      : { kind: 'local', userId: 'local', author: t.author }) satisfies Who
  }
  const g = gate(event.method, event.path, t.ok)
  if (g === 'pass') return
  if (g === 'redirect') return sendRedirect(event, '/pair', 302)
  setResponseStatus(event, 401)
  return { error: 'This device is not paired. Open /pair on it and enter a pairing code.' }
}

async function signedIn(event: H3Event) {
  const s = await resolveSession(event, { mode: 'public' })
  event.context.who = s.who
  if (s.who.kind === 'user') event.context.author = s.who.author
  const g = publicGate(event.method, event.path, s.who.kind === 'user', s.pendingDeletion)
  if (g === 'pass') return
  if (g === 'account') return sendRedirect(event, '/account', 302)
  if (g === 'not-found') {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  setResponseStatus(event, 401)
  return { error: 'Sign in first.' }
}

/** The session and OAuth cookies of this response are Secure exactly over https (server/utils/cookieSecure.ts). */
function cookieRule(event: H3Event, mode: Mode) {
  const res = (event.node as { res?: CookieRes }).res
  if (!res) return
  const encrypted = (event.node.req.socket as { encrypted?: boolean } | null | undefined)?.encrypted === true
  enforceCookieSecure(res, cookieSecure(mode, process.env, encrypted), sessionCookieName())
}

export default defineEventHandler((event) => {
  const mode = checkMode()
  cookieRule(event, mode)
  if (refusal(event)) {
    setResponseStatus(event, 403)
    return { error: 'This request names another site.' }
  }
  return mode === 'local' ? local(event) : signedIn(event)
})
