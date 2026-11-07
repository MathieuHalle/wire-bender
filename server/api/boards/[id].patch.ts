import { renameBoard, renameRefusal } from '../../utils/api'
import { useDb } from '../../db'
import { boardRequest, sendWrite } from '../../utils/sendResult'

// Access (owner only) is decided before the body is read.
export default defineEventHandler(async (event) => {
  const db = useDb()
  const req = await boardRequest(event)
  return sendWrite(event, renameRefusal(db, req), text => renameBoard(db, req, text))
})
