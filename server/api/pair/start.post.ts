import { portOf, startPairing } from '../../utils/access'

// Trusted requests only (the access middleware refuses the rest).
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  return startPairing(portOf(event))
})
