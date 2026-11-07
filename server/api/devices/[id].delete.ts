import { useDb } from '../../db'
import { unpair } from '../../utils/access'

export default defineEventHandler((event) => {
  if (!unpair(useDb(), getRouterParam(event, 'id') ?? '')) {
    setResponseStatus(event, 404)
    return { error: 'not found' }
  }
  return { ok: true }
})
