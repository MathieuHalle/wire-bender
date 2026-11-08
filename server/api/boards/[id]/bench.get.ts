import { benchBoard } from '../../../utils/api'
import { useDb } from '../../../db'
import { boardRequest, sendResult } from '../../../utils/sendResult'

/** `GET /api/boards/:key/bench?flip=lr|tb` (lr by default; anything else is 422); needs view. */
export default defineEventHandler(async event =>
  sendResult(event, benchBoard(useDb(), await boardRequest(event), undefined, getQuery(event).flip ?? 'lr')))
