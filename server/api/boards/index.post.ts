import { createOrImport } from '../../utils/api'
import { useDb } from '../../db'
import { createRefusal, withCreateLimit } from '../../utils/lifecycle'
import { authorOf, sendWrite, whoOf } from '../../utils/sendResult'

/** The board belongs to who creates it: the local user, or the signed-in user, within the board limits and the create rate. */
export default defineEventHandler(async (event) => {
  const author = authorOf(event)
  const who = whoOf(event)
  if (who.kind === 'anonymous') throw createError({ statusCode: 401, statusMessage: 'not trusted' })
  const db = useDb()
  // Refused before the body is read; checked again once it is (another create may have run meanwhile).
  return sendWrite(event, createRefusal(db, who), text => withCreateLimit(db, who, () => createOrImport(db, text, author, who.userId)))
})
