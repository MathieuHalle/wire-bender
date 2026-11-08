import { useDb } from '../../../db'
import { publicBase } from '../../../utils/mode'
import { boardRequest, sendResult } from '../../../utils/sendResult'
import { getSharing } from '../../../utils/sharing'

/** `GET /api/boards/:id/sharing`: the owner's sharing settings (404 to anyone else, and in local mode). */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  return sendResult(event, getSharing(useDb(), await boardRequest(event), publicBase()))
})
