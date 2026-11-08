import { ownerRefusal } from '../../utils/api'
import { useDb } from '../../db'
import { MAX_DELETE_BODY, deleteBoardForGood } from '../../utils/lifecycle'
import { boardRequest, refuseToken, sendWrite } from '../../utils/sendResult'

/** `DELETE /api/boards/:id` `{ confirm: <name> }`: a trashed board, for good. Owner only; access is decided before the body is read. */
export default defineEventHandler(async (event) => {
  const refused = refuseToken(event)
  if (refused) return refused
  const db = useDb()
  const req = await boardRequest(event)
  return sendWrite(event, ownerRefusal(db, req), text => deleteBoardForGood(db, req, text), MAX_DELETE_BODY)
})
