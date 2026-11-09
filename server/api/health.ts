import { useDb } from '../db'
import { checkMode } from '../utils/mode'

/** `GET` or `HEAD /api/health`: `{ ok: true, mode }` when the database answers, else 503 `{ ok: false }`. Open to anyone (the Docker healthcheck uses it). */
export default defineEventHandler((event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    setResponseStatus(event, 405)
    return { error: 'method not allowed' }
  }
  setResponseHeader(event, 'cache-control', 'no-store')
  try {
    useDb().$client.prepare('SELECT 1').get()
    return { ok: true, mode: checkMode() }
  } catch {
    setResponseStatus(event, 503)
    return { ok: false }
  }
})
