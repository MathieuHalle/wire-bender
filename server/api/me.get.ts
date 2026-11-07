import { useDb } from '../db'
import { meBody } from '../utils/accounts'
import { checkMode, configuredProviders } from '../utils/mode'
import { resolveSession } from '../utils/who'

/** `GET /api/me`: `{ mode, user, providers }`; anyone may ask. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const mode = checkMode()
  return meBody(useDb(), mode, await resolveSession(event, { mode }), configuredProviders())
})
