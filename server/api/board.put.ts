import { parseBoard } from '~core/schema'
import { boardPath, writeBoard } from '../utils/boardFile'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const baseRevision = body?.baseRevision
  if (!Number.isInteger(baseRevision)) {
    setResponseStatus(event, 422)
    return { errors: ['baseRevision must be an integer'] }
  }
  const parsed = parseBoard(body.board)
  if (!parsed.ok) {
    setResponseStatus(event, 422)
    return { errors: parsed.errors }
  }
  const r = await writeBoard(boardPath(), parsed.board, baseRevision)
  if (!r.ok) {
    setResponseStatus(event, 409)
    return { current: r.current }
  }
  return { revision: r.revision }
})
