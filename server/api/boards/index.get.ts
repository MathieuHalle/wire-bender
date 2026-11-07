import { listBoardsResponse } from '../../utils/api'
import { useDb } from '../../db'
import { sendResult } from '../../utils/sendResult'

export default defineEventHandler(event => sendResult(event, listBoardsResponse(useDb())))
