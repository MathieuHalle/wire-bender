import { renameBoard } from '../../utils/api'
import { useDb } from '../../db'
import { boardRequest, bodyText, sendResult } from '../../utils/sendResult'

export default defineEventHandler(async event => sendResult(event, renameBoard(useDb(), await boardRequest(event), await bodyText(event))))
