import { benchResponse } from '../utils/bench'
import { boardPath } from '../utils/boardFile'

export default defineEventHandler(async (event) => {
  const r = await benchResponse(boardPath())
  setResponseStatus(event, r.status)
  // content-type, no-store, nosniff and (on 200) content-disposition: see benchResponse
  setResponseHeaders(event, r.headers)
  return r.body
})
