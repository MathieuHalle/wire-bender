import type { H3Event } from 'h3'
import { MAX_BOARD_BYTES, tooLarge, type ApiResult, type BoardRequest } from './api'
import { readCapped } from './readCapped'
import { unlockedOf, type Who } from './who'

/** Send an ApiResult: its status, headers and body. */
export function sendResult(event: H3Event, r: ApiResult): unknown {
  setResponseStatus(event, r.status)
  if (r.headers) setResponseHeaders(event, r.headers)
  return r.body
}

/**
 * The request body as text, or null past `max` bytes: a larger content-length is refused
 * unread, and the body is read chunk by chunk and dropped as soon as it passes.
 */
async function bodyText(event: H3Event, max: number): Promise<string | null> {
  if (Number(getRequestHeader(event, 'content-length') ?? 0) > max) return null
  return await readCapped(event.node.req, max)
}

/**
 * Answer a write with a body: `refused` (from the access step) is sent without reading the
 * body; otherwise `write` gets the body, or the 413 is sent if it is over `max` bytes.
 */
export async function sendWrite(
  event: H3Event, refused: ApiResult | null, write: (text: string) => ApiResult | Promise<ApiResult>, max = MAX_BOARD_BYTES
): Promise<unknown> {
  if (refused) return sendResult(event, refused)
  const text = await bodyText(event, max)
  if (text === null) {
    // The rest of the body is never read; the connection closes after this answer.
    setResponseHeader(event, 'connection', 'close')
    return sendResult(event, tooLarge(max))
  }
  return sendResult(event, await write(text))
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
