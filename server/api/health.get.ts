import { useDb } from '../db'
import { checkMode } from '../utils/mode'

/** `GET /api/health`: `{ ok: true, mode }` when the database answers, else 503 `{ ok: false }`. Open to anyone (the Docker healthcheck uses it). */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  try {
    useDb().$client.prepare('SELECT 1').get()
    return { ok: true, mode: checkMode() }
  } catch {
    setResponseStatus(event, 503)
    return { ok: false }
  }
})
