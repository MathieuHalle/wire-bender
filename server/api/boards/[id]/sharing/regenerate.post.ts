import { useDb } from '../../../../db'
import { publicBase } from '../../../../utils/mode'
import { boardRequest, sendResult } from '../../../../utils/sendResult'
import { regenerateLink } from '../../../../utils/sharing'

/** `POST /api/boards/:id/sharing/regenerate`: a new share link; the old one stops working. Owner only. */
export default defineEventHandler(async event => sendResult(event, regenerateLink(useDb(), await boardRequest(event), publicBase())))
