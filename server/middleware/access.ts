import { gate, refusal, trust } from '../utils/access'

// Every request. First a request naming another site (DNS rebinding, a cross-site write)
// is refused with 403, whoever sends it. Then the machine itself and paired devices pass
// (their author is kept for the API's revisions); others get 401 from the API and the
// pairing page for pages. WebSocket upgrades do not pass here; the board socket checks
// them itself, the same way.
export default defineEventHandler((event) => {
  if (refusal(event)) {
    setResponseStatus(event, 403)
    return { error: 'This request names another site.' }
  }
  const t = trust(event)
  if (t.ok) {
    event.context.author = t.author
    event.context.device = t.device
  }
  const g = gate(event.method, event.path, t.ok)
  if (g === 'pass') return
  if (g === 'redirect') return sendRedirect(event, '/pair', 302)
  setResponseStatus(event, 401)
  return { error: 'This device is not paired. Open /pair on it and enter a pairing code.' }
})
