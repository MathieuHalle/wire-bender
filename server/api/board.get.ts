import { boardPath, readBoard } from '../utils/boardFile'

export default defineEventHandler(async (event) => {
  const path = boardPath()
  const r = await readBoard(path)
  if (!r.ok) {
    setResponseStatus(event, 422)
    return { path, errors: r.errors }
  }
  return { path, board: r.board, hash: r.hash }
})
