import { useDb } from '../../../db'
import { exportBundle } from '../../../utils/bundles'
import { boardRequest, sendResult } from '../../../utils/sendResult'

/** `GET /api/boards/:id/bundle`: the board with its whole history, as a zip. Needs view. */
export default defineEventHandler(async event => sendResult(event, exportBundle(useDb(), await boardRequest(event))))
