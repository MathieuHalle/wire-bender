// The access middleware and the board socket's upgrade/open hooks, driven with h3- and
// crossws-shaped sources (step 1 deferred minor). Nitro's auto-imported helpers are stubbed
// with the few behaviours these handlers use.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import * as encoding from 'lib0/encoding'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import type { BoardFile } from '../../core/schema'
import { closeDb, useDb } from '../../server/db'
import { boards, linkVisits, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { unlockEntry } from '../../server/utils/boardAccess'
import { createBoard, getBoardRow } from '../../server/utils/boards'
import { openRoom } from '../../server/utils/rooms'
import { docToBoard, writeBoard } from '../../shared/yboard'
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
vi.stubGlobal('replaceUserSession', async (_event: unknown, data: SessionData) => {
  session = data
})
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => (event.context.params as Record<string, string> | undefined)?.[name])
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.node.req.headers[name])
vi.stubGlobal('setResponseHeader', () => {})
vi.stubGlobal('setResponseHeaders', () => {})
// The link-password check: a stand-in for nuxt-auth-utils' scrypt.
vi.stubGlobal('verifyPassword', async (hash: string, plain: string) => hash === `h:${plain}`)
vi.stubGlobal('hashPassword', async (plain: string) => `h:${plain}`)
vi.stubGlobal('clearUserSession', async () => {
  cleared()
  session = {}
})

type Handler = (event: FakeEvent) => unknown
interface WsHooks {
  upgrade: (request: unknown) => Promise<Response | undefined> | Response | undefined
  open: (peer: unknown) => void
  message: (peer: unknown, msg: { uint8Array: () => Uint8Array }) => void
  close: (peer: unknown) => void
}

const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
let middleware: Handler
let ws: WsHooks
let unlock: Handler
let putRoute: Handler
let sharingGet: Handler
let sharingPatch: Handler
let regenerate: Handler

let dir: string

beforeAll(async () => {
  middleware = (await import('../../server/middleware/access')).default as unknown as Handler
  ws = (await import('../../server/routes/_ws/board/[id]')).default as unknown as WsHooks
  unlock = (await import('../../server/api/links/[linkId]/unlock.post')).default as unknown as Handler
  putRoute = (await import('../../server/api/boards/[id].put')).default as unknown as Handler
  sharingGet = (await import('../../server/api/boards/[id]/sharing.get')).default as unknown as Handler
  sharingPatch = (await import('../../server/api/boards/[id]/sharing.patch')).default as unknown as Handler
  regenerate = (await import('../../server/api/boards/[id]/sharing/regenerate.post')).default as unknown as Handler
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
    for (const [method, url] of [['POST', '/api/boards'], ['PATCH', '/api/me'], ['PATCH', '/api/boards/abc'], ['POST', '/api/boards/abc/fork'], ['DELETE', '/api/boards/abc'], ['POST', '/api/links/abc'], ['PUT', '/api/links/abc/unlock'], ['PATCH', '/api/boards/abc/sharing'], ['POST', '/api/boards/abc/sharing/regenerate']] as const) {
      const e = publicEvent(method, url)
      expect(await middleware(e), url).toEqual({ error: 'Sign in first.' })
      expect(e.status, url).toBe(401)
    }
  })

  it('anonymous board edits and link unlocks reach their route, which decides per board', async () => {
    for (const [method, url] of [['PUT', '/api/boards/abc'], ['POST', '/api/boards/abc/undo'], ['POST', '/api/boards/abc/redo'], ['POST', '/api/boards/abc/revisions/2/restore'], ['POST', '/api/links/abc/unlock']] as const) {
      const e = publicEvent(method, url)
      expect(await middleware(e), url).toBeUndefined()
      expect(e.context.who, url).toEqual({ kind: 'anonymous' })
    }
  })

  it('public mode does not trust loopback', async () => {
    const e = event('POST', '/api/boards', '127.0.0.1', { host: 'wire.example.org' })
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
    const e = publicEvent('POST', '/api/boards', { cookie: `wb_device=${'a'.repeat(43)}; ${SESSION_COOKIE}` })
    expect(await middleware(e)).toEqual({ error: 'Sign in first.' })
  })

  it('a suspended user is anonymous and signed out', async () => {
    const id = newUser()
    useDb().update(users).set({ suspendedAt: Date.now() }).where(eq(users.id, id)).run()
    session = { user: { id } }
    expect(await middleware(publicEvent('POST', '/api/boards'))).toEqual({ error: 'Sign in first.' })
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
    expect(await middleware(publicEvent('POST', '/api/boards'))).toEqual({ error: 'Sign in first.' })
    expect(cleared).not.toHaveBeenCalled()
  })

  it('a pendingDeletion session may restore its account; nobody else reaches the route anonymously (R1)', async () => {
    const restore = (await import('../../server/api/me/restore.post')).default as unknown as Handler
    const id = newUser()
    useDb().update(users).set({ deletedAt: Date.now() }).where(eq(users.id, id)).run()
    session = {}
    expect(await middleware(publicEvent('POST', '/api/me/restore'))).toEqual({ error: 'Sign in first.' })
    session = { user: { id }, pendingDeletion: true, unlocked: ['link-1'] }
    const e = publicEvent('POST', '/api/me/restore')
    expect(await middleware(e)).toBeUndefined()
    expect(await restore(e)).toMatchObject({ user: { id, deletedAt: null } })
    expect(useDb().select().from(users).where(eq(users.id, id)).get()!.deletedAt).toBeNull()
    expect(session).toEqual({ user: { id }, unlocked: ['link-1'] })
    // Restored: a normal session again.
    const after = publicEvent('POST', '/api/boards')
    expect(await middleware(after)).toBeUndefined()
    expect(after.context.who).toMatchObject({ kind: 'user', userId: id })
  })

  it('DELETE /api/me marks the account deleted and signs out', async () => {
    const del = (await import('../../server/api/me.delete')).default as unknown as Handler
    const id = newUser()
    session = { user: { id } }
    const e = publicEvent('DELETE', '/api/me')
    expect(await middleware(e)).toBeUndefined()
    expect(await del(e)).toMatchObject({ ok: true })
    expect(useDb().select().from(users).where(eq(users.id, id)).get()!.deletedAt).not.toBeNull()
    expect(cleared).toHaveBeenCalled()
    expect(session).toEqual({})
  })
})

describe('DELETE /api/me in local mode', () => {
  it('is 404: the local user has no deletion', async () => {
    const del = (await import('../../server/api/me.delete')).default as unknown as Handler
    const e = event('DELETE', '/api/me')
    expect(await middleware(e)).toBeUndefined()
    expect(await del(e)).toEqual({ error: 'not found' })
    expect(e.status).toBe(404)
  })
})

describe('board socket', () => {
  function peer(request: ReturnType<typeof upgradeRequest>, id = 'p1') {
    const closed: { code?: number, reason?: string }[] = []
    return {
      closed,
      peer: { id, request, context: request.context, send: () => {}, close: (code?: number, reason?: string) => closed.push({ code, reason }) }
    }
  }

  /** A board owned by `ownerId`, with `set` applied (visibility, password, trash). */
  function board(ownerId: string, set: Partial<typeof boards.$inferInsert> = {}): { id: string, linkId: string } {
    const { id } = createBoard(useDb(), fixture, 'import', 'x', ownerId)
    if (Object.keys(set).length > 0) useDb().update(boards).set(set).where(eq(boards.id, id)).run()
    return { id, linkId: getBoardRow(useDb(), id)!.linkId }
  }

  const PUBLIC_HEADERS = { host: 'wire.example.org', origin: 'https://wire.example.org' }
  const signedIn = (url: string) => upgradeRequest(url, '203.0.113.9', { ...PUBLIC_HEADERS, cookie: SESSION_COOKIE })
  const anonymous = (url: string) => upgradeRequest(url, '203.0.113.9', PUBLIC_HEADERS)

  /** A sync update message that renames the board, or makes `change`. */
  function editMessage(change: (b: BoardFile) => BoardFile = b => ({ ...b, name: 'edited by a viewer' })): Uint8Array {
    const room = openRoom(useDb(), getBoardRow(useDb(), joinedId)!.id)!
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc))
    let update: Uint8Array | null = null
    doc.on('update', (u: Uint8Array) => {
      update = u
    })
    const before = docToBoard(doc, 0)
    if (!before.ok) throw new Error(before.errors.join())
    writeBoard(doc, before.board, change(structuredClone(before.board)))
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 0)
    syncProtocol.writeUpdate(e, update!)
    return encoding.toUint8Array(e)
  }
  let joinedId = ''

  it('local mode: the machine may connect, a stranger may not', async () => {
    const b = board('local')
    const mine = upgradeRequest(`/_ws/board/${b.id}`, '127.0.0.1', { host: 'localhost:3002' })
    expect(await ws.upgrade(mine)).toBeUndefined()
    const p = peer(mine)
    ws.open(p.peer)
    expect(p.closed).toEqual([])
    ws.close(p.peer)
    const r = await ws.upgrade(upgradeRequest(`/_ws/board/${b.id}`, '192.168.1.20', { host: 'localhost:3002' }))
    expect(r?.status).toBe(401)
    const foreign = await ws.upgrade(upgradeRequest(`/_ws/board/${b.id}`, '127.0.0.1', { host: 'evil.example' }))
    expect(foreign?.status).toBe(403)
  })

  it('board id is 404 for non-owners', async () => {
    publicMode()
    const ada = newUser('Ada')
    const b = board(ada, { visibility: 'edit' })
    session = { user: { id: newUser('Bob') } }
    const unknown = await ws.upgrade(signedIn('/_ws/board/no-such-board'))
    expect(unknown?.status).toBe(404)
    const unknownBody = await unknown!.text()
    expect(JSON.parse(unknownBody)).toEqual({ error: 'not found' })
    for (const request of [signedIn(`/_ws/board/${b.id}`), anonymous(`/_ws/board/${b.id}`)]) {
      const r = await ws.upgrade(request)
      expect(r?.status).toBe(404)
      expect(await r!.text()).toBe(unknownBody)
    }
    session = { user: { id: ada } }
    expect(await ws.upgrade(signedIn(`/_ws/board/${b.id}`))).toBeUndefined()
  })

  it('a password link needs unlock first; a private or trashed one is 404', async () => {
    publicMode()
    const ada = newUser('Ada')
    const locked = board(ada, { passwordHash: 'h:x' })
    const r = await ws.upgrade(anonymous(`/_ws/board/${locked.linkId}`))
    expect(r?.status).toBe(401)
    expect(await r!.json()).toEqual({ password: true })
    session = { unlocked: [unlockEntry(locked.linkId, 'h:x')] }
    expect(await ws.upgrade(signedIn(`/_ws/board/${locked.linkId}`))).toBeUndefined()
    for (const set of [{ visibility: 'private' as const }, { trashedAt: Date.now() }]) {
      expect((await ws.upgrade(anonymous(`/_ws/board/${board(ada, set).linkId}`)))?.status).toBe(404)
    }
  })

  it('view peer\'s update closes it with 4403', async () => {
    publicMode()
    const b = board(newUser('Ada'), { visibility: 'edit' })
    joinedId = b.id
    // Anonymous on an edit link: view.
    const request = anonymous(`/_ws/board/${b.linkId}`)
    expect(await ws.upgrade(request)).toBeUndefined()
    expect(request.context.who).toEqual({ kind: 'anonymous' })
    const p = peer(request)
    ws.open(p.peer)
    expect(p.closed).toEqual([])
    expect(openRoom(useDb(), b.id)!.peerAccess('p1')).toEqual({ role: 'view', viaLink: true })
    ws.message(p.peer, { uint8Array: () => editMessage() })
    expect(p.closed).toEqual([{ code: 4403, reason: 'view only' }])
    expect(getBoardRow(useDb(), b.id)!.name).toBe(fixture.name)

    // A signed-in visitor on the same link edits; the visit is remembered.
    const bob = newUser('Bob')
    session = { user: { id: bob } }
    const signed = signedIn(`/_ws/board/${b.linkId}`)
    expect(await ws.upgrade(signed)).toBeUndefined()
    const q = peer(signed, 'p2')
    ws.open(q.peer)
    expect(openRoom(useDb(), b.id)!.peerAccess('p2')).toEqual({ role: 'edit', viaLink: true })
    ws.message(q.peer, { uint8Array: () => editMessage(x => ({ ...x, trails: x.trails.slice(1) })) })
    expect(q.closed).toEqual([])
    expect(useDb().select().from(linkVisits).all()).toMatchObject([{ userId: bob, boardId: b.id, linkId: b.linkId }])
    // But not rename it: the socket closes like any refused update.
    ws.message(q.peer, { uint8Array: () => editMessage() })
    expect(q.closed).toEqual([{ code: 4400, reason: 'Only the owner can rename the board.' }])
    expect(getBoardRow(useDb(), b.id)!.name).toBe(fixture.name)
    ws.close(q.peer)
  })

  it('access is checked again on open', async () => {
    publicMode()
    const b = board(newUser('Ada'))
    const request = anonymous(`/_ws/board/${b.linkId}`)
    expect(await ws.upgrade(request)).toBeUndefined()
    // The owner made it private between the upgrade and the open.
    useDb().update(boards).set({ visibility: 'private' }).where(eq(boards.id, b.id)).run()
    const p = peer(request)
    ws.open(p.peer)
    expect(p.closed).toEqual([{ code: 4404, reason: 'no such board' }])

    // A peer without a checked upgrade is refused.
    const q = peer(upgradeRequest(`/_ws/board/${b.linkId}`, '127.0.0.1', { host: 'wire.example.org' }))
    ws.open(q.peer)
    expect(q.closed[0]?.code).toBe(4401)
  })
})

describe('POST /api/links/:linkId/unlock', () => {
  /** An unlock request from an address, with a JSON body. */
  function unlockEvent(linkId: string, body: unknown, address = '203.0.113.9'): FakeEvent {
    const text = JSON.stringify(body)
    const req = Object.assign(req_(address), { async* [Symbol.asyncIterator]() {
      yield Buffer.from(text)
    } })
    return { node: { req }, method: 'POST', path: `/api/links/${linkId}/unlock`, context: { params: { linkId } } }
  }
  const req_ = (address: string): NodeReqLike => ({ method: 'POST', socket: { remoteAddress: address, localPort: 3002 }, headers: { 'host': 'wire.example.org', 'content-length': '20' } })

  beforeEach(async () => {
    publicMode()
    ;(await import('../../server/utils/boardAccess')).resetUnlocks()
  })

  it('password link needs unlock, then opens', async () => {
    const { id } = createBoard(useDb(), fixture, 'import', 'x', newUser('Ada'))
    useDb().update(boards).set({ passwordHash: 'h:secret' }).where(eq(boards.id, id)).run()
    const linkId = getBoardRow(useDb(), id)!.linkId
    session = { user: { id: newUser('Bob') }, unlocked: ['older'] }

    const wrong = unlockEvent(linkId, { password: 'nope' })
    expect(await unlock(wrong)).toEqual({ error: 'Wrong password.' })
    expect(wrong.status).toBe(403)
    expect(session.unlocked).toEqual(['older'])

    const right = unlockEvent(linkId, { password: 'secret' })
    expect(await unlock(right)).toEqual({ ok: true })
    expect(right.status).toBe(200)
    // The rest of the session is kept.
    expect(session).toMatchObject({ user: { id: expect.any(String) }, unlocked: ['older', unlockEntry(linkId, 'h:secret')] })
    expect(session).not.toHaveProperty('id')

    // The socket upgrade now opens.
    expect(await ws.upgrade(upgradeRequest(`/_ws/board/${linkId}`, '203.0.113.9', { host: 'wire.example.org', origin: 'https://wire.example.org', cookie: SESSION_COOKIE }))).toBeUndefined()
  })

  it('five wrong passwords then 429', async () => {
    const { id } = createBoard(useDb(), fixture, 'import', 'x', newUser('Ada'))
    useDb().update(boards).set({ passwordHash: 'h:secret' }).where(eq(boards.id, id)).run()
    const linkId = getBoardRow(useDb(), id)!.linkId
    for (let i = 0; i < 5; i++) expect((await unlock(unlockEvent(linkId, { password: 'nope' })))).toEqual({ error: 'Wrong password.' })
    const limited = unlockEvent(linkId, { password: 'secret' })
    expect(await unlock(limited)).toEqual({ error: 'Too many wrong passwords. Wait 10 minutes and try again.' })
    expect(limited.status).toBe(429)
    expect(session.unlocked).toBeUndefined()
  })
})

describe('PUT /api/boards/:key body', () => {
  /** A PUT whose body is never sent: reading it would be seen. */
  function put(key: string, who: unknown, contentLength: string): FakeEvent & { read: () => boolean } {
    let read = false
    const req = Object.assign(
      { method: 'PUT', socket: { remoteAddress: '203.0.113.9', localPort: 3002 }, headers: { 'host': 'wire.example.org', 'content-length': contentLength } } as NodeReqLike,
      { async* [Symbol.asyncIterator]() {
        read = true
        yield Buffer.from('{}')
      } }
    )
    return { node: { req }, method: 'PUT', path: `/api/boards/${key}`, context: { params: { id: key }, who }, read: () => read }
  }

  it('an anonymous PUT with a huge content-length is refused without its body being read', async () => {
    publicMode()
    const { id } = createBoard(useDb(), fixture, 'import', 'x', newUser('Ada'))
    useDb().update(boards).set({ visibility: 'edit' }).where(eq(boards.id, id)).run()
    const linkId = getBoardRow(useDb(), id)!.linkId
    const huge = String(10 ** 10)

    const anonymous = put(linkId, { kind: 'anonymous' }, huge)
    expect(await putRoute(anonymous)).toEqual({ error: 'Sign in to edit.' })
    expect(anonymous.status).toBe(403)
    expect(anonymous.read()).toBe(false)

    const unknown = put('no-such-board', { kind: 'anonymous' }, huge)
    expect(await putRoute(unknown)).toEqual({ error: 'not found' })
    expect(unknown.read()).toBe(false)

    // An editor gets 413, still without the body being read.
    const editor = put(linkId, { kind: 'user', userId: newUser('Bob'), author: 'Bob', isAdmin: false, isPremium: false }, huge)
    expect(await putRoute(editor)).toEqual({ error: 'body is larger than 2000000 bytes' })
    expect(editor.status).toBe(413)
    expect(editor.read()).toBe(false)
  })
})

describe('sharing routes', () => {
  type WhoLike = Record<string, unknown>
  /** A sharing request by `who`; its body (if any) records whether it was read. */
  function call(method: string, id: string, who: WhoLike, body?: unknown, contentLength?: string): FakeEvent & { read: () => boolean } {
    let read = false
    const text = body === undefined ? '' : JSON.stringify(body)
    const req = Object.assign(
      { method, socket: { remoteAddress: '203.0.113.9', localPort: 3002 }, headers: { 'host': 'wire.example.org', 'content-length': contentLength ?? String(Buffer.byteLength(text)) } } as NodeReqLike,
      { async* [Symbol.asyncIterator]() {
        read = true
        yield Buffer.from(text)
      } }
    )
    return { node: { req }, method, path: `/api/boards/${id}/sharing`, context: { params: { id }, who }, read: () => read }
  }
  const asUser = (userId: string, isPremium = false): WhoLike => ({ kind: 'user', userId, author: 'x', isAdmin: false, isPremium })

  it('the owner reads and changes sharing; the hash never leaves', async () => {
    publicMode()
    const ada = newUser('Ada')
    useDb().update(users).set({ isPremium: 1 }).where(eq(users.id, ada)).run()
    const { id } = createBoard(useDb(), fixture, 'import', 'x', ada)
    const linkId = getBoardRow(useDb(), id)!.linkId
    const get = call('GET', id, asUser(ada, true))
    expect(await sharingGet(get)).toEqual({ visibility: 'view', hasPassword: false, link: `https://wire.example.org/b/${linkId}`, canUsePremium: true })
    const patch = call('PATCH', id, asUser(ada, true), { visibility: 'edit', password: 'secret' })
    const body = await sharingPatch(patch)
    expect(patch.status).toBe(200)
    expect(body).toEqual({ visibility: 'edit', hasPassword: true, link: `https://wire.example.org/b/${linkId}`, canUsePremium: true })
    expect(getBoardRow(useDb(), id)!.passwordHash).toBe('h:secret')
  })

  it('a non-owner is 404 before the body is read; the owner\'s huge body is 413 unread', async () => {
    publicMode()
    const { id } = createBoard(useDb(), fixture, 'import', 'x', newUser('Ada'))
    const owner = getBoardRow(useDb(), id)!.ownerId
    const huge = String(10 ** 10)
    for (const who of [asUser(newUser('Bob'), true), { kind: 'anonymous' }]) {
      const e = call('PATCH', id, who, { visibility: 'private' }, huge)
      expect(await sharingPatch(e)).toEqual({ error: 'not found' })
      expect(e.status).toBe(404)
      expect(e.read()).toBe(false)
      const r = call('POST', id, who)
      expect(await regenerate(r)).toEqual({ error: 'not found' })
    }
    const mine = call('PATCH', id, asUser(owner), { visibility: 'edit' }, huge)
    expect(await sharingPatch(mine)).toEqual({ error: 'body is larger than 4096 bytes' })
    expect(mine.status).toBe(413)
    expect(mine.read()).toBe(false)
    expect(getBoardRow(useDb(), id)!.visibility).toBe('view')
  })

  it('local mode offers no sharing', async () => {
    const { id } = createBoard(useDb(), fixture, 'import', 'x', 'local')
    const local = { kind: 'local', userId: 'local', author: 'Local' }
    expect(await sharingGet(call('GET', id, local))).toEqual({ error: 'not found' })
    expect(await sharingPatch(call('PATCH', id, local, { visibility: 'edit' }))).toEqual({ error: 'not found' })
    expect(await regenerate(call('POST', id, local))).toEqual({ error: 'not found' })
  })

  it('regenerating the link closes link peers with 4403; the kicked socket is not read', async () => {
    publicMode()
    const ada = newUser('Ada')
    const { id } = createBoard(useDb(), fixture, 'import', 'x', ada)
    useDb().update(boards).set({ visibility: 'edit' }).where(eq(boards.id, id)).run()
    const linkId = getBoardRow(useDb(), id)!.linkId
    session = { user: { id: newUser('Bob') } }
    const request = upgradeRequest(`/_ws/board/${linkId}`, '203.0.113.9', { host: 'wire.example.org', origin: 'https://wire.example.org', cookie: SESSION_COOKIE })
    expect(await ws.upgrade(request)).toBeUndefined()
    const closed: { code?: number, reason?: string }[] = []
    const peer = { id: 'bob', request, context: request.context, send: () => {}, close: (code?: number, reason?: string) => closed.push({ code, reason }) }
    ws.open(peer)
    const room = openRoom(useDb(), id)!
    expect(room.peerAccess('bob')).toEqual({ role: 'edit', viaLink: true })
    // An edit Bob made on his own copy, sent after the kick.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc))
    let update: Uint8Array | null = null
    doc.on('update', (u: Uint8Array) => {
      update = u
    })
    const before = docToBoard(doc, 0)
    if (!before.ok) throw new Error(before.errors.join())
    writeBoard(doc, before.board, { ...before.board, name: 'after the kick' })

    const r = call('POST', id, asUser(ada))
    expect(await regenerate(r)).toEqual({ link: `https://wire.example.org/b/${getBoardRow(useDb(), id)!.linkId}` })
    expect(closed).toEqual([{ code: 4403, reason: 'access changed' }])
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 0)
    syncProtocol.writeUpdate(e, update!)
    ws.message(peer, { uint8Array: () => encoding.toUint8Array(e) })
    ws.close(peer)
    expect(getBoardRow(useDb(), id)!.name).toBe(fixture.name)
    // Reconnecting by the old link: the same 404 as an unknown board.
    expect((await ws.upgrade(upgradeRequest(`/_ws/board/${linkId}`, '203.0.113.9', { host: 'wire.example.org', origin: 'https://wire.example.org', cookie: SESSION_COOKIE })))?.status).toBe(404)
  })
})

describe('session cookie Secure only over https', () => {
  /** The parts of a Node response the cookie rule touches. */
  class FakeRes {
    readonly headers = new Map<string, number | string | string[]>()
    setHeader(name: string, value: number | string | string[]) {
      this.headers.set(name.toLowerCase(), value)
      return this
    }

    getHeader(name: string) {
      return this.headers.get(name.toLowerCase())
    }

    appendHeader(name: string, value: string | string[]) {
      const had = this.headers.get(name.toLowerCase())
      const list = had === undefined ? [] : Array.isArray(had) ? had : [String(had)]
      this.headers.set(name.toLowerCase(), [...list, ...(Array.isArray(value) ? value : [value])])
      return this
    }

    cookies(): string[] {
      const v = this.headers.get('set-cookie')
      return v === undefined ? [] : Array.isArray(v) ? v : [String(v)]
    }
  }

  const SEALED = 'nuxt-auth-session=Fe26.2**new; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax'
  const STATE = 'nuxt-auth-state=abc; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax'
  const DEVICE = 'wb_device=x; Path=/; HttpOnly; SameSite=Lax'

  /** The middleware runs on `e`, then a route writes the session and an OAuth cookie, as nuxt-auth-utils does. */
  async function cookiesAfter(e: FakeEvent) {
    const res = new FakeRes()
    ;(e.node as { res?: FakeRes }).res = res
    await middleware(e)
    res.setHeader('Set-Cookie', [SEALED])
    res.appendHeader('set-cookie', STATE)
    res.appendHeader('set-cookie', DEVICE)
    return res.cookies()
  }
  const secure = (cookie: string) => /;\s*secure\s*(;|$)/i.test(cookie)

  it('public mode with WIREBENDER_URL on https: the session and OAuth cookies are Secure', async () => {
    publicMode()
    const [session, state, device] = await cookiesAfter(publicEvent('GET', '/auth/github'))
    expect(secure(session!)).toBe(true)
    expect(secure(state!)).toBe(true)
    expect(device).toBe(DEVICE)
  })

  it('public mode with WIREBENDER_URL on http: no Secure', async () => {
    publicMode()
    vi.stubEnv('WIREBENDER_URL', 'http://wire.example.org')
    const [session, state, device] = await cookiesAfter(publicEvent('DELETE', '/api/_auth/session'))
    expect(session).toBe('nuxt-auth-session=Fe26.2**new; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax')
    expect(secure(state!)).toBe(false)
    expect(device).toBe(DEVICE)
  })

  it('local mode over http: no Secure', async () => {
    const [session, state] = await cookiesAfter(event('GET', '/'))
    expect(secure(session!)).toBe(false)
    expect(secure(state!)).toBe(false)
  })

  it('NUXT_SESSION_COOKIE_SECURE wins when it is set', async () => {
    publicMode()
    vi.stubEnv('NUXT_SESSION_COOKIE_SECURE', 'false')
    expect((await cookiesAfter(publicEvent('GET', '/'))).some(secure)).toBe(false)
    vi.stubEnv('WIREBENDER_URL', 'http://wire.example.org')
    vi.stubEnv('NUXT_SESSION_COOKIE_SECURE', 'true')
    const [session] = await cookiesAfter(publicEvent('GET', '/'))
    expect(secure(session!)).toBe(true)
  })
})
