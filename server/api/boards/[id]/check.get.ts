import { checkBoard } from '../../../utils/api'
import { useDb } from '../../../db'
import { boardId, sendResult } from '../../../utils/sendResult'

export default defineEventHandler(event => sendResult(event, checkBoard(useDb(), boardId(event))))
