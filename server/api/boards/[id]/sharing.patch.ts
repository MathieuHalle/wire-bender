import { useDb } from '../../../db'
import { publicBase } from '../../../utils/mode'
import { seal, sealKey } from '../../../utils/sealed'
import { boardRequest, sendWrite } from '../../../utils/sendResult'
import { MAX_SHARING_BODY, patchSharing, sharingRefusal } from '../../../utils/sharing'

/** `PATCH /api/boards/:id/sharing` `{ visibility?, password? }`: owner only; access is decided before the body is read. */
export default defineEventHandler(async (event) => {
  const db = useDb()
  const req = await boardRequest(event)
  const base = publicBase()
  // Public mode's appSecret is the session secret (checked at startup, plugins/startup.ts).
  const key = sealKey(String(useRuntimeConfig().appSecret))
  return sendWrite(event, sharingRefusal(db, req, base), text => patchSharing(db, req, text, { base, hash: hashPassword, seal: plain => seal(key, plain) }), MAX_SHARING_BODY)
})
