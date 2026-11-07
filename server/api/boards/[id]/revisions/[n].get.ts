import { getRevisionResponse } from '../../../../utils/api'
import { useDb } from '../../../../db'
import { boardId, sendResult } from '../../../../utils/sendResult'

export default defineEventHandler(event => sendResult(event, getRevisionResponse(useDb(), boardId(event), getRouterParam(event, 'n') ?? '')))
