import { parseBoard } from '~core/schema'
import { boardPath, writeBoard } from '../utils/boardFile'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const baseRevision = body?.baseRevision
  if (!Number.isInteger(baseRevision)) {
    setResponseStatus(event, 422)
    return { errors: ['baseRevision must be an integer'] }
  }
  const baseHash = body?.baseHash
  if (typeof baseHash !== 'string') {
    setResponseStatus(event, 422)
    return { errors: ['baseHash must be a string'] }
  }
  const parsed = parseBoard(body.board)
  if (!parsed.ok) {
    setResponseStatus(event, 422)
    return { errors: parsed.errors }
  }
  const r = await writeBoard(boardPath(), parsed.board, baseRevision, baseHash)
  if (!r.ok) {
    setResponseStatus(event, 409)
    return { current: r.current, hash: r.hash ?? null }
  }
  return { revision: r.revision, hash: r.hash }
})
