import { putBoard } from '../../utils/api'
import { useDb } from '../../db'
import { boardRequest, bodyText, sendResult } from '../../utils/sendResult'

export default defineEventHandler(async event => sendResult(event, putBoard(useDb(), await boardRequest(event), await bodyText(event))))
