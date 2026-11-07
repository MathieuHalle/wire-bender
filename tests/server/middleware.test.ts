// The access middleware and the board socket's upgrade/open hooks, driven with h3- and
// crossws-shaped sources (step 1 deferred minor). Nitro's auto-imported helpers are stubbed
// with the few behaviours these handlers use.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, useDb } from '../../server/db'
import { users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import type { NodeReqLike } from '../../server/utils/peerAddress'
import type { SessionData } from '../../server/utils/who'

interface FakeEvent {
  node: { req: NodeReqLike }
  method: string
  path: string
  context: Record<string, unknown>
  status?: number
}

let session: SessionData = {}
const cleared = vi.fn()

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('defineWebSocketHandler', (hooks: unknown) => hooks)
vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
  event.status = status
})
vi.stubGlobal('sendRedirect', (_event: FakeEvent, location: string, status: number) => ({ redirect: location, status }))
vi.stubGlobal('getUserSession', async () => session)
vi.stubGlobal('useRuntimeConfig', () => ({ session: { name: 'nuxt-auth-session' } }))
vi.stubGlobal('clearUserSession', async () => {
  cleared()
  session = {}
})

type Handler = (event: FakeEvent) => unknown
interface WsHooks {
  upgrade: (request: unknown) => Promise<Response | undefined> | Response | undefined
  open: (peer: unknown) => void
}
let middleware: Handler
let ws: WsHooks

let dir: string

beforeAll(async () => {
  middleware = (await import('../../server/middleware/access')).default as unknown as Handler
  ws = (await import('../../server/routes/_ws/board/[id]')).default as unknown as WsHooks
})
afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-mw-'))
  vi.stubEnv('WIREBENDER_DATA', dir)
  vi.stubEnv('WIREBENDER_MODE', 'local')
  session = {}
  cleared.mockClear()
})
afterEach(() => {
  closeDb()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function publicMode() {
  vi.stubEnv('WIREBENDER_MODE', 'public')
  vi.stubEnv('WIREBENDER_URL', 'https://wire.example.org')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_ID', 'id')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_SECRET', 'secret')
}

function req(remoteAddress: string, headers: Record<string, string>, method: string): NodeReqLike {
  return { method, socket: { remoteAddress, localPort: 3002 }, headers }
}

function event(method: string, url: string, remoteAddress = '127.0.0.1', headers: Record<string, string> = { host: 'localhost:3002' }): FakeEvent {
  return { node: { req: req(remoteAddress, headers, method) }, method, path: url, context: {} }
}

/** The session cookie a browser sends once it has one; its contents are `session` above. */
const SESSION_COOKIE = 'nuxt-auth-session=Fe26.2**sealed'

const publicEvent = (method: string, url: string, headers: Record<string, string> = {}) =>
  event(method, url, '203.0.113.9', { host: 'wire.example.org', cookie: SESSION_COOKIE, ...headers })

/** A crossws upgrade request (Node adapter): a Request-like proxy with the Node request as `_req`. */
function upgradeRequest(url: string, remoteAddress: string, headers: Record<string, string>) {
  return { url, headers: new Headers(headers), _req: req(remoteAddress, { ...headers, upgrade: 'websocket' }, 'GET'), context: {} as Record<string, unknown> }
}

function newUser(name = 'Ada'): string {
  const r = signIn(useDb(), 'github', { id: `gh-${name}`, name })
  if (!r.ok) throw new Error('sign-in failed')
  return r.userId
}

describe('access middleware, local mode (unchanged from step 1)', () => {
  it('the machine passes with its author; a stranger gets 401 from the API and /pair for pages', async () => {
    const e = event('PUT', '/api/boards/x')
    expect(await middleware(e)).toBeUndefined()
    expect(e.context.author).toBe('Local · This computer')
    expect(e.context.who).toEqual({ kind: 'local', userId: 'local', author: 'Local · This computer' })

    const api = event('PUT', '/api/boards/x', '192.168.1.20', { host: 'localhost:3002' })
    expect(await middleware(api)).toMatchObject({ error: expect.stringContaining('not paired') })
    expect(api.status).toBe(401)
    expect(await middleware(event('GET', '/', '192.168.1.20', { host: 'localhost:3002' }))).toEqual({ redirect: '/pair', status: 302 })
  })

  it('another site is refused', async () => {
    const e = event('GET', '/', '127.0.0.1', { host: 'evil.example' })
    expect(await middleware(e)).toEqual({ error: 'This request names another site.' })
    expect(e.status).toBe(403)
  })
})

describe('access middleware, public mode', () => {
  beforeEach(publicMode)

  it('anonymous may read pages, /api/me, /auth/* and board reads', async () => {
    for (const url of ['/', '/account', '/b/abc', '/api/me', '/auth/github', '/auth/google?code=1&state=2', '/api/boards/abc', '/api/boards/abc/check', '/api/boards/abc/revisions/2', '/_nuxt/entry.js']) {
      const e = publicEvent('GET', url)
      expect(await middleware(e), url).toBeUndefined()
      expect(e.context.who, url).toEqual({ kind: 'anonymous' })
      expect(e.context.author, url).toBeUndefined()
    }
  })

  it('anonymous writes need sign-in', async () => {
    for (const [method, url] of [['POST', '/api/boards'], ['PUT', '/api/boards/abc'], ['PATCH', '/api/me'], ['POST', '/api/boards/abc/undo']] as const) {
      const e = publicEvent(method, url)
      expect(await middleware(e), url).toEqual({ error: 'Sign in first.' })
      expect(e.status, url).toBe(401)
    }
  })

  it('public mode does not trust loopback', async () => {
    const e = event('PUT', '/api/boards/x', '127.0.0.1', { host: 'wire.example.org' })
    expect(await middleware(e)).toEqual({ error: 'Sign in first.' })
    // The machine's own names are not the public server's.
    expect(await middleware(event('GET', '/', '127.0.0.1', { host: 'localhost:3002' }))).toEqual({ error: 'This request names another site.' })
  })

  it('a signed-in user writes under their name', async () => {
    const id = newUser('Ada')
    session = { user: { id } }
    const e = publicEvent('PUT', '/api/boards/abc', { origin: 'https://wire.example.org' })
    expect(await middleware(e)).toBeUndefined()
    expect(e.context.author).toBe('Ada')
    expect(e.context.who).toEqual({ kind: 'user', userId: id, author: 'Ada', isAdmin: false, isPremium: false })
  })

  it('an odd path is the normal 404 for a signed-in user, 401 for anonymous', async () => {
    session = { user: { id: newUser() } }
    for (const url of ['/api/boards/../devices', '/a//b', '/%2e%2e/x']) {
      const e = publicEvent('GET', url)
      expect(await middleware(e), url).toEqual({ error: 'not found' })
      expect(e.status, url).toBe(404)
    }
    session = {}
    expect(await middleware(publicEvent('GET', '/a//b'))).toEqual({ error: 'Sign in first.' })
  })

  it('anyone may sign out', async () => {
    expect(await middleware(publicEvent('DELETE', '/api/_auth/session'))).toBeUndefined()
  })

  it('the pairing routes are 404', async () => {
    const id = newUser()
    for (const s of [{}, { user: { id } }]) {
      session = s
      for (const [method, url] of [['POST', '/api/pair'], ['POST', '/api/pair/start'], ['GET', '/api/devices'], ['GET', '/api/devices/me'], ['DELETE', '/api/devices/x'], ['GET', '/pair']] as const) {
        const e = publicEvent(method, url)
        expect(await middleware(e), url).toEqual({ error: 'not found' })
        expect(e.status, url).toBe(404)
      }
    }
  })

  it('a device cookie means nothing', async () => {
    const e = publicEvent('PUT', '/api/boards/abc', { cookie: `wb_device=${'a'.repeat(43)}; ${SESSION_COOKIE}` })
    expect(await middleware(e)).toEqual({ error: 'Sign in first.' })
  })

  it('a suspended user is anonymous and signed out', async () => {
    const id = newUser()
    useDb().update(users).set({ suspendedAt: Date.now() }).where(eq(users.id, id)).run()
    session = { user: { id } }
    expect(await middleware(publicEvent('PUT', '/api/boards/abc'))).toEqual({ error: 'Sign in first.' })
    expect(cleared).toHaveBeenCalled()
  })

  it('a pendingDeletion session reaches /account only (R1)', async () => {
    const id = newUser()
    useDb().update(users).set({ deletedAt: Date.now() }).where(eq(users.id, id)).run()
    session = { user: { id }, pendingDeletion: true }
    expect(await middleware(publicEvent('GET', '/'))).toEqual({ redirect: '/account', status: 302 })
    expect(await middleware(publicEvent('GET', '/b/abc'))).toEqual({ redirect: '/account', status: 302 })
    expect(await middleware(publicEvent('GET', '/account'))).toBeUndefined()
    expect(await middleware(publicEvent('GET', '/api/me'))).toBeUndefined()
    expect(await middleware(publicEvent('DELETE', '/api/_auth/session'))).toBeUndefined()
    expect(await middleware(publicEvent('PUT', '/api/boards/abc'))).toEqual({ error: 'Sign in first.' })
    expect(cleared).not.toHaveBeenCalled()
  })
})

describe('board socket', () => {
  function peer(request: ReturnType<typeof upgradeRequest>) {
    const closed: { code?: number, reason?: string }[] = []
    return {
      closed,
      peer: { id: 'p1', request, context: request.context, send: () => {}, close: (code?: number, reason?: string) => closed.push({ code, reason }) }
    }
  }

  it('local mode: the machine may connect, a stranger may not', async () => {
    expect(await ws.upgrade(upgradeRequest('/_ws/board/abc', '127.0.0.1', { host: 'localhost:3002' }))).toBeUndefined()
    const r = await ws.upgrade(upgradeRequest('/_ws/board/abc', '192.168.1.20', { host: 'localhost:3002' }))
    expect(r?.status).toBe(401)
    const foreign = await ws.upgrade(upgradeRequest('/_ws/board/abc', '127.0.0.1', { host: 'evil.example' }))
    expect(foreign?.status).toBe(403)
  })

  it('public mode: anonymous is refused, a signed-in user connects', async () => {
    publicMode()
    const anon = await ws.upgrade(upgradeRequest('/_ws/board/abc', '127.0.0.1', { host: 'wire.example.org' }))
    expect(anon?.status).toBe(401)

    const id = newUser('Ada')
    session = { user: { id } }
    const request = upgradeRequest('/_ws/board/abc', '203.0.113.9', { host: 'wire.example.org', origin: 'https://wire.example.org', cookie: SESSION_COOKIE })
    expect(await ws.upgrade(request)).toBeUndefined()
    expect(request.context.who).toMatchObject({ kind: 'user', userId: id, author: 'Ada' })

    // On open the upgrade's answer is used: past the access check, an unknown board is 4404.
    const p = peer(request)
    ws.open(p.peer)
    expect(p.closed).toEqual([{ code: 4404, reason: 'no such board' }])

    // A peer without a checked upgrade is refused.
    const q = peer(upgradeRequest('/_ws/board/abc', '127.0.0.1', { host: 'wire.example.org' }))
    ws.open(q.peer)
    expect(q.closed[0]?.code).toBe(4401)
  })
})
