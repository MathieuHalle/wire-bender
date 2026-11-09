import { useDb } from '../../db'
import { exportServerResult } from '../../utils/bundles'
import { refuseToken, sendResult, whoOf } from '../../utils/sendResult'

/** `GET /api/admin/export`: every board of every account, as bundles in one zip. The admin only (403 otherwise). */
export default defineEventHandler((event) => {
  const refused = refuseToken(event)
  if (refused) return refused
  return sendResult(event, exportServerResult(useDb(), whoOf(event)))
})
