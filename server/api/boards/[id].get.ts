import { getBoardResponse } from '../../utils/api'
import { useDb } from '../../db'
import { boardRequest, sendResult } from '../../utils/sendResult'

export default defineEventHandler(async event => sendResult(event, getBoardResponse(useDb(), await boardRequest(event))))
