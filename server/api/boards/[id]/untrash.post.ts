import { useDb } from '../../../db'
import { untrashBoard } from '../../../utils/lifecycle'
import { boardRequest, sendResult } from '../../../utils/sendResult'

/** `POST /api/boards/:id/untrash`: owner only (404 to anyone else). No body. */
export default defineEventHandler(async event => sendResult(event, untrashBoard(useDb(), await boardRequest(event))))
