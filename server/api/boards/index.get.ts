import { listBoardsResponse } from '../../utils/api'
import { useDb } from '../../db'
import { sendResult, whoOf } from '../../utils/sendResult'

/** The asker's own boards; anonymous never gets here (the access middleware). */
export default defineEventHandler((event) => {
  const who = whoOf(event)
  if (who.kind === 'anonymous') throw createError({ statusCode: 401, statusMessage: 'not trusted' })
  return sendResult(event, listBoardsResponse(useDb(), who.userId))
})
