import { describe, expect, it, vi, afterEach } from 'vitest'
import { apiCall, configFrom } from '../../cli/client'

afterEach(() => vi.unstubAllGlobals())

describe('configFrom', () => {
  it('flags beat env, env beats the default', () => {
    expect(configFrom([], {})).toEqual({ url: 'http://localhost:3000', token: undefined })
    expect(configFrom([], { WIREBENDER_SERVER: 'http://e:1', WIREBENDER_TOKEN: 'et' })).toEqual({ url: 'http://e:1', token: 'et' })
    expect(configFrom(['--url', 'http://f:2', '--token', 'ft'], { WIREBENDER_SERVER: 'http://e:1', WIREBENDER_TOKEN: 'et' })).toEqual({ url: 'http://f:2', token: 'ft' })
  })
})

describe('apiCall', () => {
  it('sends Bearer only with a token and never includes it in errors', async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers)
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
    }))
    await apiCall({ url: 'http://x' }, 'GET', '/api/boards')
    await apiCall({ url: 'http://x', token: 'SECRET' }, 'GET', '/api/boards')
    expect(seen[0]!.authorization).toBeUndefined()
    expect(seen[1]!.authorization).toBe('Bearer SECRET')

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom SECRET')))
    const r = await apiCall({ url: 'http://x', token: 'SECRET' }, 'GET', '/api/boards')
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('a network failure says Cannot reach <url>', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const r = await apiCall({ url: 'http://nowhere:9' }, 'GET', '/x')
    expect(r.status).toBe(0)
    expect((r.json as { error: string }).error).toMatch(/^Cannot reach http:\/\/nowhere:9: /)
  })
})
