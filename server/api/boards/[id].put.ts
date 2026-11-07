import { putBoard, putRefusal } from '../../utils/api'
import { useDb } from '../../db'
import { boardRequest, sendWrite } from '../../utils/sendResult'

// Access is decided before the body is read: anonymous visitors reach this route.
export default defineEventHandler(async (event) => {
  const db = useDb()
  const req = await boardRequest(event)
  return sendWrite(event, putRefusal(db, req), text => putBoard(db, req, text))
})
