import { useDb } from '../../db'
import { readCapped } from '../../utils/readCapped'
import { mintToken } from '../../utils/tokens'
import { tokenManager, whoOf } from '../../utils/sendResult'

const MAX_BODY = 4096

/**
 * `POST /api/tokens` `{ name }`: make a token. 201 `{ id, name, prefix, token }`; this is
 * the only response that ever holds `token`.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const who = tokenManager(event)
  if (!who.ok) return who.body
  // R8: in local mode a paired device cannot make a token: it would outlive unpairing the device.
  const caller = whoOf(event)
  if (caller.kind === 'local' && caller.device) {
    setResponseStatus(event, 403)
    return { error: 'Create tokens on this computer.' }
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
  const r = mintToken(useDb(), who.userId, name)
  if (!r.ok) {
    setResponseStatus(event, r.status)
    return r.body
  }
  setResponseStatus(event, 201)
  return { id: r.row.id, name: r.row.name, prefix: r.row.prefix, token: r.token }
})
