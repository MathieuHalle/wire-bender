import { benchResponse } from '../utils/bench'
import { boardPath } from '../utils/boardFile'

export default defineEventHandler(async (event) => {
  const r = await benchResponse(boardPath())
  setResponseStatus(event, r.status)
  setResponseHeader(event, 'content-type', r.contentType)
  // The sheet follows the file: never serve a stale copy.
  setResponseHeader(event, 'cache-control', 'no-store')
  if (r.filename) setResponseHeader(event, 'content-disposition', `inline; filename="${r.filename}"`)
  return r.body
})
