import { portOf, startPairing } from '../../utils/access'
import { refuseToken } from '../../utils/sendResult'

// Trusted requests only (the access middleware refuses the rest).
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const refused = refuseToken(event)
  if (refused) return refused
  return startPairing(portOf(event))
})
