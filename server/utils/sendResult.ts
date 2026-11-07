import type { H3Event } from 'h3'
import type { ApiResult, BoardRequest } from './api'
import { unlockedOf, type Who } from './who'

/** Send an ApiResult: its status, headers and body. */
export function sendResult(event: H3Event, r: ApiResult): unknown {
  setResponseStatus(event, r.status)
  if (r.headers) setResponseHeaders(event, r.headers)
  return r.body
}

/** The raw request body as text; the API checks its size before parsing it. */
export async function bodyText(event: H3Event): Promise<string> {
  return (await readRawBody(event, 'utf8')) ?? ''
}

export const boardId = (event: H3Event): string => getRouterParam(event, 'id') ?? ''

/** Who an API write is by: set by the access middleware on every trusted request. */
export function authorOf(event: H3Event): string {
  const author = event.context.author
  if (typeof author !== 'string') throw createError({ statusCode: 401, statusMessage: 'not trusted' })
  return author
}

/** Who the access middleware found; anonymous if it found no one. */
export const whoOf = (event: H3Event): Who => (event.context.who as Who | undefined) ?? { kind: 'anonymous' }

/** The board a board route is asked about (its board id or share link id) and who asks. */
export async function boardRequest(event: H3Event): Promise<BoardRequest> {
  return { key: boardId(event), who: whoOf(event), unlocked: await unlockedOf(event) }
}
