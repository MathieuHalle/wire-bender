import { portOf, startPairing } from '../../utils/access'
import { readCapped } from '../../utils/readCapped'
import { refuseToken } from '../../utils/sendResult'

const MAX_BODY = 256

// Trusted requests only (the access middleware refuses the rest). `{ keep: true }` gives the
// pending code back while it is still good (Settings › Devices opened again); no body, or
// anything else, makes a new code.
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const refused = refuseToken(event)
  if (refused) return refused
  let keep = false
  if (Number(getRequestHeader(event, 'content-length') ?? 0) <= MAX_BODY) {
    const text = await readCapped(event.node.req, MAX_BODY)
    try {
      keep = text !== null && text !== '' && (JSON.parse(text) as { keep?: unknown } | null)?.keep === true
    } catch {
      keep = false
    }
  }
  return startPairing(portOf(event), { keep })
})
