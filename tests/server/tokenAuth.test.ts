// Requests made with a personal API token (step 3, Task 2): the access middleware and the
// real route handlers, driven with h3-shaped events as in middleware.test.ts.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardFile } from '../../core/schema'
import { closeDb, useDb } from '../../server/db'
import { boards, revisions, tokens, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { createBoard, getRevision } from '../../server/utils/boards'
import { mintToken } from '../../server/utils/tokens'
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
const readSession = vi.fn(async () => session)

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('defineWebSocketHandler', (hooks: unknown) => hooks)
vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
  event.status = status
})
vi.stubGlobal('sendRedirect', (_event: FakeEvent, location: string, status: number) => ({ redirect: location, status }))
vi.stubGlobal('getUserSession', readSession)
vi.stubGlobal('useRuntimeConfig', () => ({ session: { name: 'nuxt-auth-session' } }))
vi.stubGlobal('replaceUserSession', async (_event: unknown, data: SessionData) => {
  session = data
})
vi.stubGlobal('clearUserSession', async () => {
  session = {}
})
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => (event.context.params as Record<string, string> | undefined)?.[name])
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.node.req.headers[name])
vi.stubGlobal('getQuery', (event: FakeEvent) => Object.fromEntries(new URLSearchParams(event.path.split('?')[1] ?? '')))
vi.stubGlobal('setResponseHeader', () => {})
vi.stubGlobal('setResponseHeaders', () => {})
vi.stubGlobal('appendResponseHeader', () => {})
vi.stubGlobal('verifyPassword', async (hash: string, plain: string) => hash === `h:${plain}`)
vi.stubGlobal('hashPassword', async (plain: string) => `h:${plain}`)
vi.stubGlobal('createError', (e: { statusCode: number, statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))

type Handler = (event: FakeEvent) => unknown
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
const SESSION_COOKIE = 'nuxt-auth-session=Fe26.2**sealed'

let middleware: Handler
const route: Record<string, Handler> = {}
let dir: string

beforeAll(async () => {
  middleware = (await import('../../server/middleware/access')).default as unknown as Handler
  const routes: [string, Promise<{ default: unknown }>][] = [
    ['get', import('../../server/api/boards/[id].get')],
    ['put', import('../../server/api/boards/[id].put')],
    ['create', import('../../server/api/boards/index.post')],
    ['list', import('../../server/api/boards/index.get')],
    ['trash', import('../../server/api/boards/[id]/trash.post')],
    ['untrash', import('../../server/api/boards/[id]/untrash.post')],
    ['undo', import('../../server/api/boards/[id]/undo.post')],
    ['redo', import('../../server/api/boards/[id]/redo.post')],
    ['revisions', import('../../server/api/boards/[id]/revisions/index.get')],
    ['tokensGet', import('../../server/api/tokens/index.get')],
    ['tokensPost', import('../../server/api/tokens/index.post')],
    ['tokensDelete', import('../../server/api/tokens/[id].delete')],
    ['me', import('../../server/api/me.get')]
  ]
  for (const [name, mod] of routes) route[name] = (await mod).default as Handler
})
afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-tokauth-'))
  vi.stubEnv('WIREBENDER_DATA', dir)
  vi.stubEnv('WIREBENDER_MODE', 'public')
  vi.stubEnv('WIREBENDER_URL', 'https://wire.example.org')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_ID', 'id')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_SECRET', 'secret')
  session = {}
  readSession.mockClear()
})
afterEach(() => {
  closeDb()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function newUser(name: string): string {
  const r = signIn(useDb(), 'github', { id: `gh-${name}`, name })
  if (!r.ok) throw new Error('sign-in failed')
  return r.userId
}

function mint(userId: string, name = 'Claude'): { id: string, token: string } {
  const r = mintToken(useDb(), userId, name)
  if (!r.ok) throw new Error('mint failed')
  return { id: r.row.id, token: r.token }
}

interface CallOptions { headers?: Record<string, string>, params?: Record<string, string>, body?: unknown, address?: string }

/** Every response body a test saw, for the leak scan. */
let seen: unknown[] = []

function makeEvent(method: string, url: string, o: CallOptions = {}): FakeEvent {
  const text = o.body === undefined ? '' : typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
  const headers: Record<string, string> = { 'host': 'wire.example.org', 'content-length': String(Buffer.byteLength(text)), ...o.headers }
  const req = Object.assign(
    { method, url, socket: { remoteAddress: o.address ?? '203.0.113.9', localPort: 3002 }, headers } as NodeReqLike,
    { async* [Symbol.asyncIterator]() {
      yield Buffer.from(text)
    } }
  )
  return { node: { req }, method, path: url, context: { params: o.params ?? {} } }
}

/** The middleware, then (if it lets the request through) the route: status and body. */
async function call(handler: Handler | null, method: string, url: string, o: CallOptions = {}): Promise<{ status: number, body: unknown, event: FakeEvent }> {
  const e = makeEvent(method, url, o)
  let body = await middleware(e)
  if (body === undefined && handler) body = await handler(e)
  seen.push(body)
  return { status: e.status ?? 200, body, event: e }
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

function board(ownerId: string): string {
  return createBoard(useDb(), fixture, 'import', 'x', ownerId, ownerId).id
}

describe('requests made with a token', () => {
  beforeEach(() => {
    seen = []
  })

  it('a token reads and writes the user\'s boards like the user', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    const id = board(ann)
    const got = await call(route.get!, 'GET', `/api/boards/${id}`, { headers: bearer(token), params: { id } })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ id, role: 'owner', head: 1 })
    expect(got.event.context.who).toMatchObject({ kind: 'user', userId: ann, author: 'Claude · Ann', token: { name: 'Claude' } })

    const next = { ...fixture, trails: fixture.trails.slice(1) }
    const put = await call(route.put!, 'PUT', `/api/boards/${id}`, { headers: bearer(token), params: { id }, body: { baseRevision: 1, board: next } })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ revision: 2 })

    const list = await call(route.list!, 'GET', '/api/boards', { headers: bearer(token) })
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).toContain(id)

    const created = await call(route.create!, 'POST', '/api/boards', { headers: bearer(token), body: { board: fixture } })
    expect(created.status).toBe(200)
    const newId = (created.body as { id: string }).id
    expect(useDb().select().from(boards).where(eq(boards.id, newId)).get()!.ownerId).toBe(ann)
  })

  it('a token is refused on each deny-listed route with Not allowed with a token.', async () => {
    const ann = newUser('Ann')
    useDb().update(users).set({ isAdmin: 1 }).where(eq(users.id, ann)).run()
    const { token } = mint(ann)
    const id = board(ann)
    const cases: [string, string][] = [
      ['DELETE', '/api/me'],
      ['POST', '/api/me/restore'],
      ['DELETE', `/api/boards/${id}`],
      ['PATCH', `/api/boards/${id}/sharing`],
      ['GET', `/api/boards/${id}/sharing`],
      ['POST', `/api/boards/${id}/sharing/regenerate`],
      ['GET', `/api/boards/${id}/sharing/password`],
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens'],
      ['DELETE', '/api/tokens/abc'],
      ['GET', '/api/admin/users'],
      ['PATCH', '/api/admin/users/abc'],
      ['POST', '/api/setup']
    ]
    for (const [method, url] of cases) {
      for (const u of [url, `${url}/`, `${url}?x=1`]) {
        const r = await call(null, method, u, { headers: bearer(token) })
        expect(r.body, `${method} ${u}`).toEqual({ error: 'Not allowed with a token.' })
        expect(r.status, `${method} ${u}`).toBe(403)
      }
    }
    // Signing in or linking an identity, and nuxt-auth-utils' session routes: a token must not
    // link another sign-in to its account, or read or clear a cookie session.
    for (const [method, url] of [['GET', '/auth/github'], ['GET', '/auth/google?code=1&state=2'], ['GET', '/api/_auth/session'], ['DELETE', '/api/_auth/session']] as const) {
      expect(await call(null, method, url, { headers: bearer(token) }), `${method} ${url}`).toMatchObject({ status: 403, body: { error: 'Not allowed with a token.' } })
    }
    // Not on the list: fork, PUT, undo, redo, restore.
    for (const [method, url] of [['POST', `/api/boards/${id}/fork`], ['PUT', `/api/boards/${id}`], ['POST', `/api/boards/${id}/undo`], ['POST', `/api/boards/${id}/redo`], ['POST', `/api/boards/${id}/revisions/1/restore`], ['GET', '/api/me']] as const) {
      expect(await call(null, method, url, { headers: bearer(token) }), `${method} ${url}`).toMatchObject({ body: undefined })
    }
  })

  it('trash and untrash work with a token', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    const id = board(ann)
    const t = await call(route.trash!, 'POST', `/api/boards/${id}/trash`, { headers: bearer(token), params: { id } })
    expect(t.status).toBe(200)
    expect(useDb().select().from(boards).where(eq(boards.id, id)).get()!.trashedAt).not.toBeNull()
    const u = await call(route.untrash!, 'POST', `/api/boards/${id}/untrash`, { headers: bearer(token), params: { id } })
    expect(u).toMatchObject({ status: 200, body: { trashedAt: null } })
  })

  it('a revoked token is 401 on the next call', async () => {
    const ann = newUser('Ann')
    const { id: tokenId, token } = mint(ann)
    const id = board(ann)
    expect((await call(route.get!, 'GET', `/api/boards/${id}`, { headers: bearer(token), params: { id } })).status).toBe(200)
    useDb().delete(tokens).where(eq(tokens.id, tokenId)).run()
    const r = await call(route.get!, 'GET', `/api/boards/${id}`, { headers: bearer(token), params: { id } })
    expect(r).toMatchObject({ status: 401, body: { error: 'Invalid token.' } })
  })

  it('a suspended user\'s token is 401', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    useDb().update(users).set({ suspendedAt: Date.now() }).where(eq(users.id, ann)).run()
    expect(await call(route.me!, 'GET', '/api/me', { headers: bearer(token) })).toMatchObject({ status: 401, body: { error: 'Invalid token.' } })
    // A deleted (restorable) account too.
    useDb().update(users).set({ suspendedAt: null, deletedAt: Date.now() }).where(eq(users.id, ann)).run()
    expect(await call(route.me!, 'GET', '/api/me', { headers: bearer(token) })).toMatchObject({ status: 401, body: { error: 'Invalid token.' } })
  })

  it('a wrong or malformed bearer is 401, on reads too', async () => {
    for (const b of ['wb_' + 'A'.repeat(43), 'nope', '', 'wb_short']) {
      const r = await call(route.me!, 'GET', '/api/me', { headers: { authorization: `Bearer ${b}` } })
      expect(r, b).toMatchObject({ status: 401, body: { error: 'Invalid token.' } })
    }
  })

  it('an invalid bearer never falls back to the cookie', async () => {
    const ann = newUser('Ann')
    session = { user: { id: ann } }
    const id = board(ann)
    const r = await call(route.get!, 'GET', `/api/boards/${id}`, { headers: { ...bearer('wb_' + 'B'.repeat(43)), cookie: SESSION_COOKIE }, params: { id } })
    expect(r).toMatchObject({ status: 401, body: { error: 'Invalid token.' } })
    expect(readSession).not.toHaveBeenCalled()
  })

  it('a valid token with another user\'s cookie acts as the token\'s user', async () => {
    const ann = newUser('Ann')
    const bob = newUser('Bob')
    useDb().update(users).set({ isAdmin: 1 }).where(eq(users.id, bob)).run()
    session = { user: { id: bob } }
    const { token } = mint(ann)
    const r = await call(route.me!, 'GET', '/api/me', { headers: { ...bearer(token), cookie: SESSION_COOKIE } })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ user: { id: ann } })
    expect(r.event.context.who).toMatchObject({ kind: 'user', userId: ann, isAdmin: false })
    expect(readSession).not.toHaveBeenCalled()
  })

  it('a token\'s revision has author "<token> · <user>", author_id and token_id', async () => {
    const ann = newUser('Ann')
    const { id: tokenId, token } = mint(ann)
    const id = board(ann)
    const next = { ...fixture, trails: fixture.trails.slice(1) }
    await call(route.put!, 'PUT', `/api/boards/${id}`, { headers: bearer(token), params: { id }, body: { baseRevision: 1, board: next } })
    const rev = useDb().select().from(revisions).where(eq(revisions.boardId, id)).all().find(r => r.n === 2)!
    expect(rev).toMatchObject({ author: 'Claude · Ann', authorId: ann, tokenId })
    // A board made with a token too.
    const created = await call(route.create!, 'POST', '/api/boards', { headers: bearer(token), body: { board: fixture } })
    const first = useDb().select().from(revisions).where(eq(revisions.boardId, (created.body as { id: string }).id)).get()!
    expect(first).toMatchObject({ author: 'Claude · Ann', authorId: ann, tokenId })
  })

  it('undo of a token revision is summarised "undo of #N by <token>"', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    const id = board(ann)
    const next = { ...fixture, trails: fixture.trails.slice(1) }
    await call(route.put!, 'PUT', `/api/boards/${id}`, { headers: bearer(token), params: { id }, body: { baseRevision: 1, board: next } })
    // The token is revoked before the undo: the summary comes from the revision itself.
    useDb().delete(tokens).run()
    session = { user: { id: ann } }
    const cookie = { cookie: SESSION_COOKIE }
    expect((await call(route.undo!, 'POST', `/api/boards/${id}/undo`, { headers: cookie, params: { id } })).body).toEqual({ revision: 3 })
    expect((await call(route.redo!, 'POST', `/api/boards/${id}/redo`, { headers: cookie, params: { id } })).body).toEqual({ revision: 4 })
    const list = (await call(route.revisions!, 'GET', `/api/boards/${id}/revisions`, { headers: cookie, params: { id } })).body as { n: number, summary: string, author: string }[]
    expect(list.find(r => r.n === 3)).toMatchObject({ author: 'Ann', summary: 'undo of #2 by Claude · Ann' })
    expect(list.find(r => r.n === 4)).toMatchObject({ author: 'Ann', summary: 'redo of #2 by Claude · Ann' })
    // One revision read alone says the same (R1 wherever the history shows).
    expect(getRevision(useDb(), id, 3)!.summary).toBe('undo of #2 by Claude · Ann')
    expect(getRevision(useDb(), id, 4)!.summary).toBe('redo of #2 by Claude · Ann')
  })

  it('every undo and redo is summarised with the target revision\'s author (R1)', async () => {
    const ann = newUser('Ann')
    session = { user: { id: ann } }
    const cookie = { cookie: SESSION_COOKIE }
    const id = board(ann)
    await call(route.put!, 'PUT', `/api/boards/${id}`, { headers: cookie, params: { id }, body: { baseRevision: 1, board: { ...fixture, trails: fixture.trails.slice(1) } } })
    await call(route.undo!, 'POST', `/api/boards/${id}/undo`, { headers: cookie, params: { id } })
    await call(route.redo!, 'POST', `/api/boards/${id}/redo`, { headers: cookie, params: { id } })
    const list = (await call(route.revisions!, 'GET', `/api/boards/${id}/revisions`, { headers: cookie, params: { id } })).body as { n: number, how: string, summary: string }[]
    expect(list.map(r => [r.n, r.how])).toEqual([[4, 'redo'], [3, 'undo'], [2, 'api'], [1, 'import']])
    expect(list.find(r => r.n === 3)!.summary).toBe('undo of #2 by Ann')
    expect(list.find(r => r.n === 4)!.summary).toBe('redo of #2 by Ann')
  })

  it('the token string appears in no response, revision or presence state', async () => {
    const ann = newUser('Ann')
    session = { user: { id: ann } }
    const minted = await call(route.tokensPost!, 'POST', '/api/tokens', { headers: { cookie: SESSION_COOKIE }, body: { name: 'Claude' } })
    const token = (minted.body as { token: string }).token
    session = {}
    seen = []
    const id = board(ann)
    const h = bearer(token)
    await call(route.get!, 'GET', `/api/boards/${id}`, { headers: h, params: { id } })
    await call(route.put!, 'PUT', `/api/boards/${id}`, { headers: h, params: { id }, body: { baseRevision: 1, board: { ...fixture, trails: fixture.trails.slice(1) } } })
    await call(route.put!, 'PUT', `/api/boards/${id}`, { headers: h, params: { id }, body: { baseRevision: 1, board: fixture } })
    await call(route.undo!, 'POST', `/api/boards/${id}/undo`, { headers: h, params: { id } })
    await call(route.revisions!, 'GET', `/api/boards/${id}/revisions`, { headers: h, params: { id } })
    await call(route.me!, 'GET', '/api/me', { headers: h })
    await call(route.tokensGet!, 'GET', '/api/tokens', { headers: h })
    await call(route.me!, 'GET', '/api/me', { headers: bearer(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')) })
    const secret = token.slice(3)
    expect(seen.length).toBe(8)
    for (const body of seen) expect(JSON.stringify(body) ?? '').not.toContain(secret)
    for (const table of [revisions, boards, users]) expect(JSON.stringify(useDb().select().from(table).all())).not.toContain(secret)
    expect(JSON.stringify(useDb().select().from(tokens).all())).not.toContain(secret)
    const { openRoom } = await import('../../server/utils/rooms')
    const room = openRoom(useDb(), id)!
    expect(JSON.stringify([...room.awareness.getStates().values()])).not.toContain(secret)
  })

  it('a token in ?token= is ignored: the request is anonymous', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    const r = await call(route.create!, 'POST', `/api/boards?token=${token}`, { body: { board: fixture } })
    expect(r).toMatchObject({ status: 401, body: { error: 'Sign in first.' } })
    const me = await call(route.me!, 'GET', `/api/me?token=${token}`)
    expect(me.event.context.who).toEqual({ kind: 'anonymous' })
  })

  it('last_used_at is set on use, at most once a minute', async () => {
    const ann = newUser('Ann')
    const { id: tokenId, token } = mint(ann)
    expect(useDb().select().from(tokens).where(eq(tokens.id, tokenId)).get()!.lastUsedAt).toBeNull()
    const lastUsed = () => useDb().select().from(tokens).where(eq(tokens.id, tokenId)).get()!.lastUsedAt
    const t0 = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0)
    try {
      await call(route.me!, 'GET', '/api/me', { headers: bearer(token) })
      expect(lastUsed()).toBe(t0)
      // Inside the minute: no write.
      clock.mockReturnValue(t0 + 59_000)
      await call(route.me!, 'GET', '/api/me', { headers: bearer(token) })
      expect(lastUsed()).toBe(t0)
      clock.mockReturnValue(t0 + 61_000)
      await call(route.me!, 'GET', '/api/me', { headers: bearer(token) })
      expect(lastUsed()).toBe(t0 + 61_000)
    } finally {
      clock.mockRestore()
    }
  })

  it('a failed last_used_at write never fails the request', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    useDb().$client.exec('CREATE TRIGGER no_touch BEFORE UPDATE ON tokens BEGIN SELECT RAISE(FAIL, \'busy\'); END')
    const r = await call(route.me!, 'GET', '/api/me', { headers: bearer(token) })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ user: { id: ann } })
  })

  it('odd spellings of a denied route are refused too', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    const id = board(ann)
    for (const [method, url] of [['DELETE', '/API/ME'], ['DELETE', '/Api/Me/'], ['DELETE', '//api/me'], ['DELETE', '/api//me'], ['DELETE', '/api/me%2f'], ['DELETE', '/api%2fme'], ['DELETE', `/api/boards/x/../${id}`], ['DELETE', `/api/boards/${id}/`], ['GET', '/api/tokens/'], ['GET', '/API/TOKENS']] as const) {
      const r = await call(null, method, url, { headers: bearer(token) })
      expect(r, `${method} ${url}`).toMatchObject({ status: 403, body: { error: 'Not allowed with a token.' } })
    }
  })

  it('a token cannot unlock a password link, and no session cookie is read or sent (R5)', async () => {
    const unlock = (await import('../../server/api/links/[linkId]/unlock.post')).default as unknown as Handler
    const ann = newUser('Ann')
    const bob = newUser('Bob')
    const id = board(ann)
    useDb().update(boards).set({ visibility: 'view', passwordHash: 'h:secret' }).where(eq(boards.id, id)).run()
    const linkId = useDb().select().from(boards).where(eq(boards.id, id)).get()!.linkId
    const { token } = mint(bob)
    session = { user: { id: bob } }
    const before = structuredClone(session)
    const cookies: string[] = []
    const record = (_e: unknown, name: string, value: string) => {
      if (name.toLowerCase() === 'set-cookie') cookies.push(value)
    }
    vi.stubGlobal('setResponseHeader', record)
    vi.stubGlobal('appendResponseHeader', record)
    try {
      for (const headers of [{ ...bearer(token), cookie: SESSION_COOKIE }, bearer(token)]) {
        const r = await call(unlock, 'POST', `/api/links/${linkId}/unlock`, { headers, params: { linkId }, body: { password: 'secret' } })
        expect(r).toMatchObject({ status: 403, body: { error: 'Not allowed with a token.' } })
      }
      // The route refuses it itself as well.
      const e = makeEvent('POST', `/api/links/${linkId}/unlock`, { headers: bearer(token), params: { linkId }, body: { password: 'secret' } })
      expect(await unlock(e)).toEqual({ error: 'Not allowed with a token.' })
      expect(e.status).toBe(403)
    } finally {
      vi.stubGlobal('setResponseHeader', () => {})
      vi.stubGlobal('appendResponseHeader', () => {})
    }
    expect(cookies).toEqual([])
    expect(session).toEqual(before)
    expect(readSession).not.toHaveBeenCalled()
  })

  it('the account, delete-for-good, admin and setup routes refuse a token themselves', async () => {
    const ann = newUser('Ann')
    useDb().update(users).set({ isAdmin: 1 }).where(eq(users.id, ann)).run()
    const { token } = mint(ann)
    const id = board(ann)
    useDb().update(boards).set({ trashedAt: Date.now() }).where(eq(boards.id, id)).run()
    const routes: [Promise<{ default: unknown }>, string, string][] = [
      [import('../../server/api/me.delete'), 'DELETE', '/api/me'],
      [import('../../server/api/me/restore.post'), 'POST', '/api/me/restore'],
      [import('../../server/api/boards/[id].delete'), 'DELETE', `/api/boards/${id}`],
      [import('../../server/api/admin/users.get'), 'GET', '/api/admin/users'],
      [import('../../server/api/admin/users/[id].patch'), 'PATCH', `/api/admin/users/${ann}`],
      [import('../../server/api/setup.post'), 'POST', '/api/setup']
    ]
    for (const [mod, method, url] of routes) {
      const h = (await mod).default as Handler
      // Without the middleware: the route sees the bearer itself.
      const e = makeEvent(method, url, { headers: bearer(token), params: { id: url.includes('admin') ? ann : id }, body: { confirm: fixture.name, admin: false, code: 'x' } })
      expect(await h(e), `${method} ${url}`).toEqual({ error: 'Not allowed with a token.' })
      expect(e.status, `${method} ${url}`).toBe(403)
    }
    expect(useDb().select().from(boards).where(eq(boards.id, id)).get()).toBeDefined()
    expect(useDb().select().from(users).where(eq(users.id, ann)).get()).toMatchObject({ deletedAt: null, isAdmin: 1 })
  })

  it('a bearer request without Origin passes the site check; a foreign Origin is still refused', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    expect((await call(route.create!, 'POST', '/api/boards', { headers: bearer(token), body: { board: fixture } })).status).toBe(200)
    const foreign = await call(route.create!, 'POST', '/api/boards', { headers: { ...bearer(token), origin: 'https://evil.example' }, body: { board: fixture } })
    expect(foreign).toMatchObject({ status: 403, body: { error: 'This request names another site.' } })
  })
})

describe('/api/tokens routes', () => {
  it('anonymous gets 401', async () => {
    for (const [h, method, url] of [[route.tokensGet!, 'GET', '/api/tokens'], [route.tokensPost!, 'POST', '/api/tokens'], [route.tokensDelete!, 'DELETE', '/api/tokens/x']] as const) {
      expect((await call(h, method, url, { params: { id: 'x' }, body: { name: 'a' } })).status, `${method} ${url}`).toBe(401)
    }
  })

  it('an over-cap body gets 413', async () => {
    session = { user: { id: newUser('Ann') } }
    const r = await call(route.tokensPost!, 'POST', '/api/tokens', { headers: { cookie: SESSION_COOKIE }, body: { name: 'x'.repeat(5000) } })
    expect(r.status).toBe(413)
  })

  it('POST returns 201 with exactly {id,name,prefix,token}; GET never has hash or token', async () => {
    session = { user: { id: newUser('Ann') } }
    const r = await call(route.tokensPost!, 'POST', '/api/tokens', { headers: { cookie: SESSION_COOKIE }, body: { name: 'Claude' } })
    expect(r.status).toBe(201)
    expect(Object.keys(r.body as object).sort()).toEqual(['id', 'name', 'prefix', 'token'])
    const list = await call(route.tokensGet!, 'GET', '/api/tokens', { headers: { cookie: SESSION_COOKIE } })
    expect(list.status).toBe(200)
    const rows = list.body as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    for (const row of rows) {
      expect(row).not.toHaveProperty('hash')
      expect(row).not.toHaveProperty('token')
    }
    expect(JSON.stringify(rows)).not.toContain((r.body as { token: string }).token.slice(3))
  })

  it('a token caller is refused with 403 even with a valid cookie session', async () => {
    const ann = newUser('Ann')
    session = { user: { id: ann } }
    const { id, token } = mint(ann)
    const headers = { ...bearer(token), cookie: SESSION_COOKIE }
    for (const [h, method, url] of [[route.tokensGet!, 'GET', '/api/tokens'], [route.tokensPost!, 'POST', '/api/tokens'], [route.tokensDelete!, 'DELETE', `/api/tokens/${id}`]] as const) {
      const r = await call(h, method, url, { headers, params: { id }, body: { name: 'more' } })
      expect(r, `${method} ${url}`).toMatchObject({ status: 403, body: { error: 'Not allowed with a token.' } })
    }
    expect(useDb().select().from(tokens).all()).toHaveLength(1)
  })

  it('a token route refuses a token caller even when reached without the middleware', async () => {
    const ann = newUser('Ann')
    const { id, token } = mint(ann)
    for (const h of [route.tokensGet!, route.tokensPost!, route.tokensDelete!]) {
      const e = makeEvent('POST', '/api/tokens', { headers: bearer(token), params: { id }, body: { name: 'x' } })
      e.context.who = { kind: 'user', userId: ann, author: 'Claude · Ann', isAdmin: false, isPremium: false, token: { id, name: 'Claude' } }
      expect(await h(e)).toEqual({ error: 'Not allowed with a token.' })
      expect(e.status).toBe(403)
    }
  })
})

describe('pairing and devices (R4)', () => {
  const PAIRING: [string, string][] = [['POST', '/api/pair/start'], ['POST', '/api/pair'], ['GET', '/api/devices'], ['GET', '/api/devices/me'], ['DELETE', '/api/devices/abc']]

  it('public mode: a token gets 403 on the pairing and device routes', async () => {
    const { token } = mint(newUser('Ann'))
    for (const [method, url] of PAIRING) {
      expect(await call(null, method, url, { headers: bearer(token) }), `${method} ${url}`).toMatchObject({ status: 403, body: { error: 'Not allowed with a token.' } })
    }
  })

  it('local mode: a token cannot start pairing, pair, list devices or unpair one', async () => {
    vi.stubEnv('WIREBENDER_MODE', 'local')
    vi.stubEnv('WIREBENDER_URL', '')
    const { resetPairing, startPairing, completePairing, listDevices } = await import('../../server/utils/access')
    resetPairing()
    const start = (await import('../../server/api/pair/start.post')).default as unknown as Handler
    const pair = (await import('../../server/api/pair.post')).default as unknown as Handler
    const list = (await import('../../server/api/devices/index.get')).default as unknown as Handler
    const unpair = (await import('../../server/api/devices/[id].delete')).default as unknown as Handler
    // The owner's tablet, paired the normal way.
    const { code } = startPairing()
    expect(completePairing(code, 'Tablet', '192.168.1.30').ok).toBe(true)
    const tablet = listDevices()[0]!
    const pending = startPairing()

    const { token } = mint('local')
    const headers = { host: 'localhost:3002', ...bearer(token) }
    for (const address of ['127.0.0.1', '192.168.1.20']) {
      const s = await call(start, 'POST', '/api/pair/start', { headers, address })
      expect(s, address).toMatchObject({ status: 403, body: { error: 'Not allowed with a token.' } })
      const p = await call(pair, 'POST', '/api/pair', { headers, address, body: { code: pending.code, name: 'Rogue' } })
      expect(p, address).toMatchObject({ status: 403, body: { error: 'Not allowed with a token.' } })
      expect(await call(list, 'GET', '/api/devices', { headers, address }), address).toMatchObject({ status: 403 })
      const d = await call(unpair, 'DELETE', `/api/devices/${tablet.id}`, { headers, address, params: { id: tablet.id } })
      expect(d, address).toMatchObject({ status: 403, body: { error: 'Not allowed with a token.' } })
    }
    expect(listDevices().map(d => d.name)).toEqual(['Tablet'])
    // The pending code was never used up by the token.
    expect(completePairing(pending.code, 'Phone', '192.168.1.31').ok).toBe(true)
  })

  it('local mode: POST /api/pair/start keeps the pending code with { keep: true } only', async () => {
    vi.stubEnv('WIREBENDER_MODE', 'local')
    vi.stubEnv('WIREBENDER_URL', '')
    const { resetPairing } = await import('../../server/utils/access')
    resetPairing()
    const start = (await import('../../server/api/pair/start.post')).default as unknown as Handler
    const headers = { host: 'localhost:3002' }
    const address = '127.0.0.1'
    const first = await call(start, 'POST', '/api/pair/start', { headers, address })
    const kept = await call(start, 'POST', '/api/pair/start', { headers, address, body: { keep: true } })
    expect((kept.body as { code: string }).code).toBe((first.body as { code: string }).code)
    expect((kept.body as { expiresAt: number }).expiresAt).toBe((first.body as { expiresAt: number }).expiresAt)
    const fresh = await call(start, 'POST', '/api/pair/start', { headers, address, body: { keep: 'yes' } })
    expect((fresh.body as { expiresAt: number }).expiresAt).toBeGreaterThanOrEqual((first.body as { expiresAt: number }).expiresAt)
    expect(fresh.body).not.toEqual(kept.body)
  })
})

describe('local mode', () => {
  beforeEach(() => {
    vi.stubEnv('WIREBENDER_MODE', 'local')
    vi.stubEnv('WIREBENDER_URL', '')
  })

  it('local mode: a valid token from a non-loopback address is local, and author "<token> · Local"', async () => {
    const { id: tokenId, token } = mint('local', 'Claude')
    const id = board('local')
    const host = { host: 'localhost:3002' }
    const got = await call(route.get!, 'GET', `/api/boards/${id}`, { headers: { ...host, ...bearer(token) }, params: { id }, address: '192.168.1.20' })
    expect(got.status).toBe(200)
    expect(got.event.context.who).toEqual({ kind: 'local', userId: 'local', author: 'Claude · Local', token: { id: tokenId, name: 'Claude' } })
    await call(route.put!, 'PUT', `/api/boards/${id}`, { headers: { ...host, ...bearer(token) }, params: { id }, address: '192.168.1.20', body: { baseRevision: 1, board: { ...fixture, trails: fixture.trails.slice(1) } } })
    expect(useDb().select().from(revisions).where(eq(revisions.boardId, id)).all().find(r => r.n === 2)).toMatchObject({ author: 'Claude · Local', authorId: 'local', tokenId })
    // A bad token from the machine itself is still 401: the bearer decides.
    const bad = await call(route.get!, 'GET', `/api/boards/${id}`, { headers: { ...host, ...bearer('wb_' + 'C'.repeat(43)) }, params: { id }, address: '127.0.0.1' })
    expect(bad).toMatchObject({ status: 401, body: { error: 'Invalid token.' } })
    // The deny-list holds here too.
    expect(await call(route.tokensGet!, 'GET', '/api/tokens', { headers: { ...host, ...bearer(token) }, address: '127.0.0.1' })).toMatchObject({ status: 403 })
  })

  it('R8: this computer makes tokens; a paired device gets 403 but can still list and revoke', async () => {
    const { resetPairing, startPairing, completePairing } = await import('../../server/utils/access')
    resetPairing()
    const paired = completePairing(startPairing().code, 'Tablet', '192.168.1.30')
    if (!paired.ok) throw new Error('pairing failed')
    const device = { host: 'localhost:3002', cookie: /^(wb_device=[^;]+)/.exec(paired.cookie)![1]! }
    const computer = { host: 'localhost:3002' }

    const refused = await call(route.tokensPost!, 'POST', '/api/tokens', { headers: device, address: '192.168.1.30', body: { name: 'Rogue' } })
    expect(refused).toMatchObject({ status: 403, body: { error: 'Create tokens on this computer.' } })
    expect(useDb().select().from(tokens).all()).toHaveLength(0)

    const made = await call(route.tokensPost!, 'POST', '/api/tokens', { headers: computer, address: '127.0.0.1', body: { name: 'Laptop' } })
    expect(made.status).toBe(201)
    const id = (made.body as { id: string }).id

    const listed = await call(route.tokensGet!, 'GET', '/api/tokens', { headers: device, address: '192.168.1.30' })
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)
    const gone = await call(route.tokensDelete!, 'DELETE', `/api/tokens/${id}`, { headers: device, address: '192.168.1.30', params: { id } })
    expect(gone.status).toBe(204)
    expect(useDb().select().from(tokens).all()).toHaveLength(0)
  })

  it('a public account\'s token is not valid in local mode', async () => {
    const ann = newUser('Ann')
    const { token } = mint(ann)
    const r = await call(route.me!, 'GET', '/api/me', { headers: { host: 'localhost:3002', ...bearer(token) }, address: '127.0.0.1' })
    expect(r).toMatchObject({ status: 401, body: { error: 'Invalid token.' } })
  })
})
