import { undoBoard } from '../../../utils/api'
import { useDb } from '../../../db'
import { authorOf, boardId, sendResult } from '../../../utils/sendResult'

export default defineEventHandler(event => sendResult(event, undoBoard(useDb(), boardId(event), authorOf(event))))
