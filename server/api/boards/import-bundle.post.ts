import { useDb } from '../../db'
import { MAX_BUNDLE_BYTES } from '~core/bundle'
import { importBundle } from '../../utils/bundles'
import { createRefusal, withCreateLimit } from '../../utils/lifecycle'
import { readCappedBytes } from '../../utils/readCapped'
import { sendResult, whoOf } from '../../utils/sendResult'

/**
 * `POST /api/boards/import-bundle`: a bundle zip as the raw body (`application/zip` or
 * `application/octet-stream`) becomes a new board of the caller's, within the board limits and
 * the create rate. Refused before the body is read when the type is wrong or a limit is hit.
 */
export default defineEventHandler(async (event) => {
  const who = whoOf(event)
  if (who.kind === 'anonymous') throw createError({ statusCode: 401, statusMessage: 'not trusted' })
  const db = useDb()
  const type = (getRequestHeader(event, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/zip' && type !== 'application/octet-stream') {
    return sendResult(event, { status: 415, body: { error: 'send the bundle as application/zip' } })
  }
  const refused = createRefusal(db, who)
  if (refused) return sendResult(event, refused)
  const tooLarge = () => {
    // The rest of the body is never read; the connection closes after this answer.
    setResponseHeader(event, 'connection', 'close')
    return sendResult(event, { status: 413, body: { error: `body is larger than ${MAX_BUNDLE_BYTES} bytes` } })
  }
  if (Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BUNDLE_BYTES) return tooLarge()
  const bytes = await readCappedBytes(event.node.req, MAX_BUNDLE_BYTES)
  if (bytes === null) return tooLarge()
  return sendResult(event, withCreateLimit(db, who, () => importBundle(db, bytes, who)))
})
