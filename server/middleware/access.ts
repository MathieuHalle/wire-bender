import type { H3Event } from 'h3'
import { TOKEN_REFUSED, gate, publicGate, refusal, tokenRefusal } from '../utils/access'
import { cookieSecure, enforceCookieSecure, type CookieRes } from '../utils/cookieSecure'
import { checkMode, type Mode } from '../utils/mode'
import { INVALID_TOKEN, resolveSession, sessionCookieName, type SessionState } from '../utils/who'

// Every request. First a request naming another site (DNS rebinding, a cross-site write)
// is refused with 403, whoever sends it. WebSocket upgrades do not pass here; the board
// socket checks them itself, the same way.
//
// Local mode: the machine itself and paired devices pass (their author is kept for the
// API's revisions); others get 401 from the API and the pairing page for pages. No session
// is ever read: /api/_auth/* is 404.
//
// Public mode: who is asking comes from the session alone (never loopback or a device
// cookie). Anonymous visitors may read; writes need a signed-in user (server/utils/access.ts
// `publicGate`); the pairing routes do not exist.
//
// Both modes: a request with `Authorization: Bearer` is decided by its token alone
// (resolveSession): a bad one is 401 `Invalid token.`, and a good one acts as its user except
// on the routes `tokenRefusal` lists (403).

/** The answer for a request made with a token, before any route: 401, 403, or null to go on. */
function tokenAnswer(event: H3Event, s: SessionState) {
  if (s.invalidToken) {
    setResponseStatus(event, 401)
    return { error: INVALID_TOKEN }
  }
  if (s.who.kind !== 'anonymous' && s.who.token && tokenRefusal(event.path, event.method)) {
    setResponseStatus(event, 403)
    return { error: TOKEN_REFUSED }
  }
  return null
}

async function local(event: H3Event) {
  // nuxt-auth-utils' own session routes: local mode has no sessions, and reading one would
  // reseal (or, in a build without a secret, throw on) another server's cookie.
  if (/^\/api\/_auth(\/|$)/.test(event.path.split('?')[0]!)) {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  const s = await resolveSession(event, { mode: 'local' })
  const refused = tokenAnswer(event, s)
  if (refused) return refused
  const trusted = s.who.kind === 'local'
  if (s.who.kind === 'local') {
    event.context.author = s.who.author
    event.context.device = s.who.device
    event.context.who = s.who
  }
  const g = gate(event.method, event.path, trusted)
  if (g === 'pass') return
  if (g === 'redirect') return sendRedirect(event, '/pair', 302)
  setResponseStatus(event, 401)
  return { error: 'This device is not paired. Open /pair on it and enter a pairing code.' }
}

async function signedIn(event: H3Event) {
  const s = await resolveSession(event, { mode: 'public' })
  const refused = tokenAnswer(event, s)
  if (refused) return refused
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
