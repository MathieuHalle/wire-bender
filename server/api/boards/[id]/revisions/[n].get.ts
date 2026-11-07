import { getRevisionResponse } from '../../../../utils/api'
import { useDb } from '../../../../db'
import { boardRequest, sendResult } from '../../../../utils/sendResult'

export default defineEventHandler(async event => sendResult(event, getRevisionResponse(useDb(), await boardRequest(event), getRouterParam(event, 'n') ?? '')))
