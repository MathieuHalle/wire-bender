import { gate, trust } from '../utils/access'

// Every request: the machine itself and paired devices pass (their author is kept for the
// API's revisions); others get 401 from the API and the pairing page for pages. WebSocket
// upgrades do not pass here; the board socket checks them itself.
export default defineEventHandler((event) => {
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
