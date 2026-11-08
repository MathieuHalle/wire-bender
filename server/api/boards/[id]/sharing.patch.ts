import { useDb } from '../../../db'
import { publicBase } from '../../../utils/mode'
import { boardRequest, sendWrite } from '../../../utils/sendResult'
import { MAX_SHARING_BODY, patchSharing, sharingRefusal } from '../../../utils/sharing'

/** `PATCH /api/boards/:id/sharing` `{ visibility?, password? }`: owner only; access is decided before the body is read. */
export default defineEventHandler(async (event) => {
  const db = useDb()
  const req = await boardRequest(event)
  const base = publicBase()
  return sendWrite(event, sharingRefusal(db, req, base), text => patchSharing(db, req, text, { base, hash: hashPassword }), MAX_SHARING_BODY)
})
