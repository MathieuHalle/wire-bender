import { thumbnailBoard } from '../../../utils/api'
import { useDb } from '../../../db'
import { boardRequest, sendResult } from '../../../utils/sendResult'

/** `GET /api/boards/:key/thumbnail`: an SVG of the board's top side; needs view. */
export default defineEventHandler(async event => sendResult(event, thumbnailBoard(useDb(), await boardRequest(event))))
