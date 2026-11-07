import { redoBoard } from '../../../utils/api'
import { useDb } from '../../../db'
import { boardRequest, sendResult } from '../../../utils/sendResult'

export default defineEventHandler(async event => sendResult(event, redoBoard(useDb(), await boardRequest(event))))
