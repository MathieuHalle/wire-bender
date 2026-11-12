import type { H3Event } from 'h3'
import { tooLarge, type ApiResult, type BoardRequest } from './api'
import { TOKEN_REFUSED, bearerOf } from './access'
import { MAX_BODY_BYTES } from './boards'
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
  event: H3Event, refused: ApiResult | null, write: (text: string) => ApiResult | Promise<ApiResult>, max = MAX_BODY_BYTES
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

/**
 * For a route a token may never use (the middleware's deny-list, checked again here in case a
 * route is ever reached another way): 403 `Not allowed with a token.` for any request with a
 * bearer header or made with a token, else null.
 */
export function refuseToken(event: H3Event): { error: string } | null {
  const who = whoOf(event)
  if (bearerOf(event) === undefined && !(who.kind !== 'anonymous' && who.token)) return null
  setResponseStatus(event, 403)
  return { error: TOKEN_REFUSED }
}

/**
 * The caller of a token management route (`/api/tokens`): who the middleware found, which a
 * bearer decides over any cookie. A request with a token is 403 (refuseToken); anonymous is 401.
 */
export function tokenManager(event: H3Event): { ok: true, userId: string } | { ok: false, body: { error: string } } {
  const refused = refuseToken(event)
  if (refused) return { ok: false, body: refused }
  const who = whoOf(event)
  if (who.kind === 'anonymous') {
    setResponseStatus(event, 401)
    return { ok: false, body: { error: 'Sign in first.' } }
  }
  return { ok: true, userId: who.userId }
}
