import { useDb } from '../../../db'
import { trashBoard } from '../../../utils/lifecycle'
import { boardRequest, sendResult } from '../../../utils/sendResult'

/** `POST /api/boards/:id/trash`: owner only (404 to anyone else). No body. */
export default defineEventHandler(async event => sendResult(event, trashBoard(useDb(), await boardRequest(event))))
