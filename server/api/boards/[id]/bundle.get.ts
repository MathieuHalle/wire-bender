import { useDb } from '../../../db'
import { exportBundle } from '../../../utils/bundles'
import { clientAddress } from '../../../utils/clientAddress'
import { boardRequest, sendResult } from '../../../utils/sendResult'

/** `GET /api/boards/:id/bundle`: the board with its whole history, as a zip. Needs view. Throttled (429). */
export default defineEventHandler(async event =>
  sendResult(event, exportBundle(useDb(), await boardRequest(event), clientAddress(event.node.req))))
