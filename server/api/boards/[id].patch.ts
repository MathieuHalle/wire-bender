import { renameBoard } from '../../utils/api'
import { useDb } from '../../db'
import { bodyText, boardId, sendResult } from '../../utils/sendResult'

export default defineEventHandler(async event => sendResult(event, renameBoard(useDb(), boardId(event), await bodyText(event))))
