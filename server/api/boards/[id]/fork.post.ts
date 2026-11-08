import { useDb } from '../../../db'
import { fork } from '../../../utils/lifecycle'
import { boardRequest, sendResult } from '../../../utils/sendResult'

/** `POST /api/boards/:key/fork`: a copy in the signed-in asker's account (a duplicate on their own board). No body. */
export default defineEventHandler(async event => sendResult(event, fork(useDb(), await boardRequest(event))))
