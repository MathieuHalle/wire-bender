// The first-run setup code (spec §3): it makes the first admin in public mode, who takes
// over the local user's boards. Nitro's helpers and nuxt-auth-utils' session are stubbed.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardFile } from '../../core/schema'
import { closeDb, useDb } from '../../server/db'
import { boards, revisions, setup, users } from '../../server/db/schema'
import { SETUP_ALPHABET, checkSetupCode, claimSetup, newSetupCode, resetSetupTries, setupDone, setupNotice, signIn } from '../../server/utils/accounts'
import * as api from '../../server/utils/api'
import { access } from '../../server/utils/boardAccess'
import { createBoard, listRevisions } from '../../server/utils/boards'
import { insecureCookieWarning } from '../../server/utils/cookieSecure'
import { finishSignIn } from '../../server/utils/oauth'
import { openRoom, type PeerLink } from '../../server/utils/rooms'
import type { NodeReqLike } from '../../server/utils/peerAddress'
import type { SessionData, Who } from '../../server/utils/who'

interface FakeEvent { node: { req: NodeReqLike }, method: string, path: string, context: Record<string, unknown>, status?: number }

let session: SessionData = {}

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
  event.status = status
})
vi.stubGlobal('setResponseHeader', () => {})
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.node.req.headers[name])
vi.stubGlobal('sendRedirect', (_event: unknown, location: string, status: number) => ({ redirect: location, status }))
vi.stubGlobal('getUserSession', async () => session)
vi.stubGlobal('replaceUserSession', async (_event: unknown, data: SessionData) => {
  session = data
})
vi.stubGlobal('clearUserSession', async () => {
  session = {}
})
vi.stubGlobal('useRuntimeConfig', () => ({ session: { name: 'nuxt-auth-session' } }))

type Handler = (event: FakeEvent) => unknown
let setupRoute: Handler
let middleware: Handler
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
const LOCAL: Who = { kind: 'local', userId: 'local', author: 'Local · This computer' }
const COOKIE = 'nuxt-auth-session=Fe26.2**sealed'
let dir: string

beforeAll(async () => {
  setupRoute = (await import('../../server/api/setup.post')).default as unknown as Handler
  middleware = (await import('../../server/middleware/access')).default as unknown as Handler
})
afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-setup-'))
  vi.stubEnv('WIREBENDER_DATA', dir)
  vi.stubEnv('WIREBENDER_MODE', 'public')
  vi.stubEnv('WIREBENDER_URL', 'https://wire.example.org')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_ID', 'id')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_SECRET', 'secret')
  session = {}
  resetSetupTries()
})
afterEach(() => {
  closeDb()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** `POST /api/setup` from an address, with the session cookie once a session exists. */
function post(body: unknown, address = '203.0.113.9', method = 'POST', url = '/api/setup'): FakeEvent {
  const text = JSON.stringify(body)
  const cookie = Object.keys(session).length > 0 ? { cookie: COOKIE } : {}
  const req = Object.assign(
    { method, socket: { remoteAddress: address, localPort: 3002 }, headers: { 'host': 'wire.example.org', 'content-length': String(text.length), ...cookie } },
    { async* [Symbol.asyncIterator]() {
      yield Buffer.from(text)
    } }
  )
  return { node: { req }, method, path: url, context: {} }
}

/** The sign-in callback request, with the session cookie once a session exists. */
function callback() {
  const cookie = Object.keys(session).length > 0 ? { cookie: COOKIE } : {}
  return { node: { req: { method: 'GET', headers: { host: 'wire.example.org', ...cookie } } }, context: {} } as never
}

/** The session tag `POST /api/setup` would store for `code` (R11). */
function accepted(code: string): string {
  const r = checkSetupCode(useDb(), code, '192.0.2.1')
  if (r.status !== 200) throw new Error('code refused')
  return r.tag
}

const userRow = (id: string) => useDb().select().from(users).where(eq(users.id, id)).get()!
const byName = (name: string) => useDb().select().from(users).all().find(u => u.name === name)!

describe('setup code', () => {
  it('is 12 characters of the alphabet, shown as XXXX-XXXX-XXXX, and only its sha256 is stored', () => {
    const code = newSetupCode(useDb())
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    for (const c of code.replaceAll('-', '')) expect(SETUP_ALPHABET).toContain(c)
    const rows = useDb().select().from(setup).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows)).not.toContain(code.replaceAll('-', ''))
  })

  it('setup code works once, then 410', async () => {
    const code = newSetupCode(useDb())
    // Dashes and case are ignored.
    const e = post({ code: code.replaceAll('-', '').toLowerCase() })
    expect(await setupRoute(e)).toEqual({ ok: true, admin: false })
    expect(e.status).toBeUndefined()
    // A tag of the accepted code's hash (R11): never the code, never the hash itself.
    const tag = session.setupOk as string
    expect(tag).toMatch(/^[\w-]{12,}$/)
    expect(useDb().select().from(setup).get()!.codeHash).not.toContain(tag)
    expect(tag).not.toContain(code.replaceAll('-', ''))

    expect(await finishSignIn(callback(), 'github', { id: '42', name: 'Ada' })).toEqual({ redirect: '/', status: 302 })
    const ada = byName('Ada')
    expect(ada).toMatchObject({ isAdmin: 1, isPremium: 1 })
    // Used: the session no longer holds it.
    expect(session).toEqual({ user: { id: ada.id } })
    expect(useDb().select().from(setup).all()).toEqual([{ codeHash: null, doneAt: expect.any(Number) }])
    expect(setupDone(useDb())).toBe(true)

    for (const body of [{ code }, { code: 'WRONG-CODE-HERE' }]) {
      const again = post(body)
      expect(await setupRoute(again)).toEqual({ error: 'Setup is done.' })
      expect(again.status).toBe(410)
    }
    // A second person who signs in with the same accepted code is no admin, and is told so.
    session = { setupOk: tag }
    expect(await finishSignIn(callback(), 'github', { id: '7', name: 'Bob' })).toEqual({ redirect: '/setup?error=done', status: 302 })
    expect(byName('Bob')).toMatchObject({ isAdmin: 0, isPremium: 0 })
    expect(session).toEqual({ user: { id: byName('Bob').id } })
  })

  it('a code accepted before a restart can no longer claim (R11)', async () => {
    createBoard(useDb(), fixture, 'import', 'Local')
    const old = newSetupCode(useDb())
    expect(await setupRoute(post({ code: old }))).toEqual({ ok: true, admin: false })
    expect(session.setupOk).toEqual(expect.any(String))
    // The server restarts: a new code.
    newSetupCode(useDb())
    expect(await finishSignIn(callback(), 'github', { id: '42', name: 'Ada' })).toEqual({ redirect: '/setup?error=done', status: 302 })
    expect(byName('Ada')).toMatchObject({ isAdmin: 0, isPremium: 0 })
    expect(setupDone(useDb())).toBe(false)
    expect(useDb().select({ ownerId: boards.ownerId }).from(boards).all()).toEqual([{ ownerId: 'local' }])
    // A forged flag claims nothing either.
    session = {}
    for (const forged of [true, 'x', '']) {
      session = { setupOk: forged }
      await finishSignIn(callback(), 'github', { id: `f-${String(forged)}`, name: 'Forger' })
      session = {}
    }
    expect(setupDone(useDb())).toBe(false)
  })

  it('a restart makes the old code useless', async () => {
    const old = newSetupCode(useDb())
    const fresh = newSetupCode(useDb())
    expect(fresh).not.toBe(old)
    const e = post({ code: old })
    expect(await setupRoute(e)).toEqual({ error: 'Wrong setup code.' })
    expect(e.status).toBe(403)
    expect(session).toEqual({})
    const ok = post({ code: fresh })
    expect(await setupRoute(ok)).toEqual({ ok: true, admin: false })
  })

  it('wrong codes: 5 per address per 10 minutes, then 429 even for the right one', async () => {
    const code = newSetupCode(useDb())
    for (let i = 0; i < 5; i++) expect(await setupRoute(post({ code: 'AAAA-AAAA-AAAA' }))).toEqual({ error: 'Wrong setup code.' })
    const e = post({ code })
    expect(await setupRoute(e)).toEqual({ error: 'Too many wrong codes. Wait 10 minutes and try again.' })
    expect(e.status).toBe(429)
    expect(session).toEqual({})
    // Another address is not held back.
    expect(await setupRoute(post({ code }, '198.51.100.4'))).toEqual({ ok: true, admin: false })
  })

  it('tries sent in parallel all count', async () => {
    newSetupCode(useDb())
    const results = await Promise.all(Array.from({ length: 8 }, () => setupRoute(post({ code: 'AAAA-AAAA-AAAA' }))))
    expect(results.filter(r => (r as { error: string }).error.startsWith('Too many'))).toHaveLength(3)
  })

  it('a missing or odd code is a wrong try, never a crash', async () => {
    newSetupCode(useDb())
    for (const body of [{}, { code: 42 }, { code: '' }, null]) {
      const e = post(body)
      expect(await setupRoute(e)).toEqual({ error: 'Wrong setup code.' })
      expect(e.status).toBe(403)
    }
  })

  it('a signed-in session that enters the code is admin at once (R9)', async () => {
    const r = signIn(useDb(), 'github', { id: '42', name: 'Ada' })
    if (!r.ok) throw new Error('sign-in failed')
    session = { user: { id: r.userId }, unlocked: ['link-1'] }
    const code = newSetupCode(useDb())
    expect(await setupRoute(post({ code }))).toEqual({ ok: true, admin: true })
    expect(userRow(r.userId)).toMatchObject({ isAdmin: 1, isPremium: 1 })
    expect(session).toEqual({ user: { id: r.userId }, unlocked: ['link-1'] })
    expect(setupDone(useDb())).toBe(true)
  })

  it('local mode has no setup: 404', async () => {
    vi.stubEnv('WIREBENDER_MODE', 'local')
    const e = post({ code: 'AAAA-AAAA-AAAA' })
    expect(await setupRoute(e)).toEqual({ error: 'not found' })
    expect(e.status).toBe(404)
  })

  it('anonymous POST /api/setup reaches its route; nothing near it does', async () => {
    expect(await middleware(post({ code: 'x' }))).toBeUndefined()
    expect(await middleware(post({ code: 'x' }, undefined, 'POST', '/api/setup/'))).toBeUndefined()
    for (const [method, url] of [['POST', '/api/setup/x'], ['POST', '/api/setupx'], ['PUT', '/api/setup'], ['GET', '/api/setup']] as const) {
      const e = post({}, undefined, method, url)
      expect(await middleware(e), `${method} ${url}`).toEqual({ error: 'Sign in first.' })
    }
  })
})

describe('setup notice at start', () => {
  it('public mode with no admin: a new code, logged with where to enter it', () => {
    const line = setupNotice(useDb(), 'public', 'https://wire.example.org/')!
    expect(line).toMatch(/^\[wirebender\] setup code: [A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4} — enter it at https:\/\/wire\.example\.org\/setup$/)
  })

  it('nothing in local mode, or once an admin exists; the local user is no admin for this', () => {
    expect(userRow('local').isAdmin).toBe(1)
    expect(setupNotice(useDb(), 'local', null)).toBeNull()
    expect(useDb().select().from(setup).all()).toEqual([])
    const r = signIn(useDb(), 'github', { id: '42', name: 'Ada' })
    if (!r.ok) throw new Error('sign-in failed')
    expect(claimSetup(useDb(), r.userId, accepted(newSetupCode(useDb())))).toMatchObject({ ok: true })
    expect(setupNotice(useDb(), 'public', 'https://wire.example.org')).toBeNull()
    expect(useDb().select().from(setup).all()).toEqual([{ codeHash: null, doneAt: expect.any(Number) }])
  })
})

describe('local → public', () => {
  it('setup admin takes over the local user\'s boards with their revisions', async () => {
    const db = useDb()
    const a = createBoard(db, fixture, 'import', 'Local · This computer')
    expect(api.putBoard(db, { key: a.id, who: LOCAL }, JSON.stringify({ board: { ...fixture, name: 'Second' } })).status).toBe(200)
    const b = createBoard(db, { ...fixture, name: 'Trashed one' }, 'import', 'Local · iPad')
    db.update(boards).set({ trashedAt: Date.now() }).where(eq(boards.id, b.id)).run()
    const bob = signIn(db, 'github', { id: '7', name: 'Bob' })
    if (!bob.ok) throw new Error('sign-in failed')
    const bobs = createBoard(db, fixture, 'import', 'Bob', bob.userId, bob.userId)
    const historyBefore = db.select().from(revisions).all()

    // A visitor on a local board's link stays connected through the move.
    db.update(boards).set({ visibility: 'edit' }).where(eq(boards.id, a.id)).run()
    const closed: number[] = []
    const link: PeerLink = { update: () => {}, awareness: () => {}, close: code => closed.push(code) }
    openRoom(db, a.id)!.join('visitor', 'Bob', link, { role: 'edit', viaLink: true, authorId: bob.userId })

    const code = newSetupCode(db)
    await setupRoute(post({ code }))
    await finishSignIn(callback(), 'github', { id: '42', name: 'Ada' })
    const ada = byName('Ada')

    expect(db.select({ id: boards.id, ownerId: boards.ownerId }).from(boards).all().sort((x, y) => x.id.localeCompare(y.id)))
      .toEqual([{ id: a.id, ownerId: ada.id }, { id: b.id, ownerId: ada.id }, { id: bobs.id, ownerId: bob.userId }].sort((x, y) => x.id.localeCompare(y.id)))
    // History stays as written: same rows, the same authors and author ids.
    expect(db.select().from(revisions).all()).toEqual(historyBefore)
    expect(listRevisions(db, a.id).map(r => r.author)).toEqual(['Local · This computer', 'Local · This computer'])
    const adaWho: Who = { kind: 'user', userId: ada.id, author: 'Ada', isAdmin: true, isPremium: true }
    expect(access(db, adaWho, a.id, [])).toMatchObject({ ok: true, role: 'owner' })
    expect(api.listBoardsResponse(db, ada.id, 'mine').body).toHaveLength(1)
    expect(closed).toEqual([])
  })

  it('claiming is only once, by a real account, with the current code', () => {
    const db = useDb()
    createBoard(db, fixture, 'import', 'Local')
    const ada = signIn(db, 'github', { id: '42', name: 'Ada' })
    const bob = signIn(db, 'github', { id: '7', name: 'Bob' })
    if (!ada.ok || !bob.ok) throw new Error('sign-in failed')
    const tag = accepted(newSetupCode(db))
    expect(claimSetup(db, 'local', tag)).toEqual({ ok: false })
    expect(claimSetup(db, 'nobody', tag)).toEqual({ ok: false })
    expect(claimSetup(db, ada.userId, 'not-the-tag')).toEqual({ ok: false })
    expect(claimSetup(db, ada.userId, tag)).toEqual({ ok: true, moved: 1 })
    expect(claimSetup(db, bob.userId, tag)).toEqual({ ok: false })
    expect(userRow(bob.userId).isAdmin).toBe(0)
  })

  it('claiming is all or nothing', () => {
    const db = useDb()
    const board = createBoard(db, fixture, 'import', 'Local')
    const ada = signIn(db, 'github', { id: '42', name: 'Ada' })
    if (!ada.ok) throw new Error('sign-in failed')
    const tag = accepted(newSetupCode(db))
    // The last step (marking the setup done) fails, after the promotion and the board move.
    db.$client.exec('CREATE TRIGGER no_setup_update BEFORE UPDATE ON setup BEGIN SELECT RAISE(ABORT, \'boom\'); END')
    expect(() => claimSetup(db, ada.userId, tag)).toThrow('boom')
    expect(userRow(ada.userId)).toMatchObject({ isAdmin: 0, isPremium: 0 })
    expect(db.select({ ownerId: boards.ownerId }).from(boards).where(eq(boards.id, board.id)).get()).toEqual({ ownerId: 'local' })
    expect(setupDone(db)).toBe(false)
    db.$client.exec('DROP TRIGGER no_setup_update')
    expect(claimSetup(db, ada.userId, tag)).toEqual({ ok: true, moved: 1 })
  })
})

describe('startup warning', () => {
  it('public mode with http:// on a non-loopback host warns that the session cookie is not Secure', () => {
    const warn = (url: string, extra: Record<string, string> = {}) => insecureCookieWarning('public', { WIREBENDER_URL: url, ...extra })
    expect(warn('http://wire.example.org')).toBe('[wirebender] WIREBENDER_URL is http:// on wire.example.org: the session cookie will not be Secure, so anyone on the network path can read it. Use https.')
    expect(warn('http://192.168.1.20:3002')).toContain('192.168.1.20')
    for (const url of ['https://wire.example.org', 'http://localhost:3002', 'http://127.0.0.1:3002', 'http://[::1]:3002']) expect(warn(url), url).toBeNull()
    // Forced Secure: the cookie is Secure, nothing to warn about.
    expect(warn('http://wire.example.org', { NUXT_SESSION_COOKIE_SECURE: 'true' })).toBeNull()
    expect(insecureCookieWarning('local', { WIREBENDER_URL: 'http://wire.example.org' })).toBeNull()
  })
})
