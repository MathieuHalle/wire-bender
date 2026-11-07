import { restoreRevision } from '../../../../../utils/api'
import { useDb } from '../../../../../db'
import { boardId, sendResult } from '../../../../../utils/sendResult'

export default defineEventHandler(event => sendResult(event, restoreRevision(useDb(), boardId(event), getRouterParam(event, 'n') ?? '')))
