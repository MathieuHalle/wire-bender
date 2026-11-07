import { useDb } from '../db'
import { MAX_NAME, meBody, rename } from '../utils/accounts'
import { readCapped } from '../utils/readCapped'
import { checkMode, configuredProviders } from '../utils/mode'
import { resolveSession } from '../utils/who'

const MAX_BODY = 4096

/** `PATCH /api/me` `{ name }`: a signed-in user's display name (1 to 60 chars). */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const mode = checkMode()
  const state = await resolveSession(event, { mode })
  if (state.who.kind !== 'user') {
    setResponseStatus(event, mode === 'local' ? 400 : 401)
    return { error: mode === 'local' ? 'Local mode has no account to rename.' : 'Sign in first.' }
  }
  const text = Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY ? null : await readCapped(event.node.req, MAX_BODY)
  if (text === null) {
    setResponseStatus(event, 413)
    return { error: 'body too large' }
  }
  let name: unknown
  try {
    name = (JSON.parse(text) as { name?: unknown } | null)?.name
  } catch {
    name = undefined
  }
  if (!rename(useDb(), state.who.userId, name)) {
    setResponseStatus(event, 422)
    return { errors: [`name: must be 1 to ${MAX_NAME} characters`] }
  }
  return meBody(useDb(), mode, await resolveSession(event, { mode }), configuredProviders())
})
