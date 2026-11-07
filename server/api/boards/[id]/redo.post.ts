import { redoBoard } from '../../../utils/api'
import { useDb } from '../../../db'
import { authorOf, boardId, sendResult } from '../../../utils/sendResult'

export default defineEventHandler(event => sendResult(event, redoBoard(useDb(), boardId(event), authorOf(event))))
