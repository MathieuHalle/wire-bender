import { useDb } from '../../../../db'
import { publicBase } from '../../../../utils/mode'
import { sealKey, unseal } from '../../../../utils/sealed'
import { boardRequest, sendResult } from '../../../../utils/sendResult'
import { getSharingPassword } from '../../../../utils/sharing'

/** `GET /api/boards/:id/sharing/password`: the link password, for the owner only (404 to anyone else; 403 to a token). */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  // Public mode's appSecret is the session secret (checked at startup, plugins/startup.ts).
  const key = sealKey(String(useRuntimeConfig().appSecret))
  return sendResult(event, getSharingPassword(useDb(), await boardRequest(event), publicBase(), sealed => unseal(key, sealed)))
})
