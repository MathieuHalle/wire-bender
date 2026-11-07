import { benchBoard } from '../../../utils/api'
import { useDb } from '../../../db'
import { boardId, sendResult } from '../../../utils/sendResult'

export default defineEventHandler(event => sendResult(event, benchBoard(useDb(), boardId(event))))
