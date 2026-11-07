import type { H3Event } from 'h3'
import type { ApiResult } from './api'

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
