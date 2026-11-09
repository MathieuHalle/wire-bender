// GET /api/health: the Docker healthcheck. Open to anyone in both modes; 503 when the
// database does not answer. Nitro's helpers are stubbed.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { gate, publicGate } from '../../server/utils/access'

interface FakeEvent { method: string, status?: number }

let broken = false
vi.mock('../../server/db', () => ({
  useDb: () => ({
    $client: {
      prepare: () => ({
        get: () => {
          if (broken) throw new Error('database is locked')
          return { 1: 1 }
        }
      })
    }
  })
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
  event.status = status
})
vi.stubGlobal('setResponseHeader', () => {})

let health: (event: FakeEvent) => unknown
const KEYS = ['WIREBENDER_MODE', 'WIREBENDER_URL', 'NUXT_OAUTH_GITHUB_CLIENT_ID', 'NUXT_OAUTH_GITHUB_CLIENT_SECRET']
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))

beforeAll(async () => {
  health = (await import('../../server/api/health')).default as unknown as typeof health
})
afterEach(() => {
  broken = false
  for (const k of KEYS) {
    Reflect.deleteProperty(process.env, k)
    if (saved[k] !== undefined) process.env[k] = saved[k]
  }
})
afterAll(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/health', () => {
  it('is 200 {ok:true, mode} without sign-in in public mode', () => {
    process.env.WIREBENDER_MODE = 'public'
    process.env.WIREBENDER_URL = 'https://wire.example.org'
    process.env.NUXT_OAUTH_GITHUB_CLIENT_ID = 'test-client-id'
    process.env.NUXT_OAUTH_GITHUB_CLIENT_SECRET = 'test-client-secret'
    const event: FakeEvent = { method: 'GET' }
    expect(health(event)).toEqual({ ok: true, mode: 'public' })
    expect(event.status).toBeUndefined()
    expect(publicGate('GET', '/api/health', false)).toBe('pass')
    expect(publicGate('HEAD', '/api/health', false)).toBe('pass')
  })

  it('is 200 {ok:true, mode} in local mode, for an unpaired device too', () => {
    process.env.WIREBENDER_MODE = 'local'
    const event: FakeEvent = { method: 'GET' }
    expect(health(event)).toEqual({ ok: true, mode: 'local' })
    expect(gate('GET', '/api/health', false)).toBe('pass')
  })

  it('answers HEAD like GET and refuses other methods with 405', () => {
    process.env.WIREBENDER_MODE = 'local'
    const head: FakeEvent = { method: 'HEAD' }
    expect(health(head)).toEqual({ ok: true, mode: 'local' })
    expect(head.status).toBeUndefined()
    const post: FakeEvent = { method: 'POST' }
    health(post)
    expect(post.status).toBe(405)
  })

  it('is 503 {ok:false} when SELECT 1 fails', () => {
    process.env.WIREBENDER_MODE = 'local'
    broken = true
    const event: FakeEvent = { method: 'GET' }
    expect(health(event)).toEqual({ ok: false })
    expect(event.status).toBe(503)
  })

  it('opens nothing else: only GET and HEAD of exactly /api/health', () => {
    expect(publicGate('POST', '/api/health', false)).toBe('deny')
    expect(publicGate('GET', '/api/health/x', false)).toBe('deny')
    expect(publicGate('GET', '/api/healthz', false)).toBe('deny')
    expect(gate('POST', '/api/health', false)).toBe('deny')
    expect(gate('GET', '/api/health/x', false)).toBe('deny')
  })
})
