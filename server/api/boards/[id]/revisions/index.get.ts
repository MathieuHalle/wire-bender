import { listRevisionsResponse } from '../../../../utils/api'
import { useDb } from '../../../../db'
import { boardId, sendResult } from '../../../../utils/sendResult'

export default defineEventHandler(event => sendResult(event, listRevisionsResponse(useDb(), boardId(event))))
