import { createOrImport } from '../../utils/api'
import { useDb } from '../../db'
import { authorOf, bodyText, sendResult, whoOf } from '../../utils/sendResult'

/** The board belongs to who creates it: the local user, or the signed-in user. */
export default defineEventHandler(async (event) => {
  const author = authorOf(event)
  const who = whoOf(event)
  if (who.kind === 'anonymous') throw createError({ statusCode: 401, statusMessage: 'not trusted' })
  return sendResult(event, createOrImport(useDb(), await bodyText(event), author, who.userId))
})
