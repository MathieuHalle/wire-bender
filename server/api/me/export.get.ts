import { useDb } from '../../db'
import { exportAllResult } from '../../utils/bundles'
import { sendResult, whoOf } from '../../utils/sendResult'

/** `GET /api/me/export`: every board of the caller (not the trashed ones) as bundles in one zip. */
export default defineEventHandler(event => sendResult(event, exportAllResult(useDb(), whoOf(event))))
