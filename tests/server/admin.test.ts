// The admin routes (spec §3): the accounts list, the premium flag and suspension. Admin
// only; anyone else gets the plain 404 of an unknown route. Nitro's helpers are stubbed.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardFile } from '../../core/schema'
import { closeDb, useDb } from '../../server/db'
import { boards, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { access, recordVisit, type Access } from '../../server/utils/boardAccess'
import { createBoard, listShared } from '../../server/utils/boards'
import { openRoom, type PeerLink } from '../../server/utils/rooms'
import type { NodeReqLike } from '../../server/utils/peerAddress'
import { whoIs, type SessionData, type Who } from '../../server/utils/who'

interface FakeEvent { node: { req: NodeReqLike }, method: string, path: string, context: Record<string, unknown>, status?: number }

let session: SessionData = {}

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
  event.status = status
})
vi.stubGlobal('setResponseHeader', () => {})
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.node.req.headers[name])
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => (event.context.params as Record<string, string> | undefined)?.[name])
vi.stubGlobal('getUserSession', async () => session)
vi.stubGlobal('clearUserSession', async () => {
  session = {}
})
vi.stubGlobal('useRuntimeConfig', () => ({ session: { name: 'nuxt-auth-session' } }))

type Handler = (event: FakeEvent) => unknown
let list: Handler
let patch: Handler
let unknown: Handler
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
let dir: string

beforeAll(async () => {
  list = (await import('../../server/api/admin/users.get')).default as unknown as Handler
  patch = (await import('../../server/api/admin/users/[id].patch')).default as unknown as Handler
  unknown = (await import('../../server/api/[...]')).default as unknown as Handler
})
afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-admin-'))
  vi.stubEnv('WIREBENDER_DATA', dir)
  vi.stubEnv('WIREBENDER_MODE', 'public')
  vi.stubEnv('WIREBENDER_URL', 'https://wire.example.org')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_ID', 'id')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_SECRET', 'secret')
  session = {}
})
afterEach(() => {
  closeDb()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function account(name: string, createdAt: number, admin = false): string {
  const r = signIn(useDb(), 'github', { id: `gh-${name}`, name }, undefined, createdAt)
  if (!r.ok) throw new Error('sign-in failed')
  if (admin) useDb().update(users).set({ isAdmin: 1, isPremium: 1 }).where(eq(users.id, r.userId)).run()
  return r.userId
}

/** A request as `asId` (signed in), with a JSON body for PATCH. */
function call(method: string, url: string, asId: string | null, body?: unknown, params: Record<string, string> = {}): FakeEvent {
  session = asId ? { user: { id: asId } } : {}
  const text = body === undefined ? '' : JSON.stringify(body)
  const req = Object.assign(
    { method, socket: { remoteAddress: '203.0.113.9', localPort: 3002 }, headers: { 'host': 'wire.example.org', 'content-length': String(text.length), ...(asId ? { cookie: 'nuxt-auth-session=Fe26.2**sealed' } : {}) } },
    { async* [Symbol.asyncIterator]() {
      yield Buffer.from(text)
    } }
  )
  return { node: { req }, method, path: url, context: { params } }
}

const patchAs = (asId: string | null, id: string, body: unknown) => {
  const e = call('PATCH', `/api/admin/users/${id}`, asId, body, { id })
  return { e, result: patch(e) }
}

const row = (id: string) => useDb().select().from(users).where(eq(users.id, id)).get()!

describe('admin routes', () => {
  it('non-admin gets 404 from admin routes', async () => {
    account('Admin', 1, true)
    const bob = account('Bob', 2)
    const target = account('Cy', 3)
    for (const asId of [bob, null]) {
      const e = call('GET', '/api/admin/users', asId)
      expect(await list(e)).toEqual({ error: 'not found' })
      expect(e.status).toBe(404)
      const p = patchAs(asId, target, { premium: true })
      expect(await p.result).toEqual({ error: 'not found' })
      expect(p.e.status).toBe(404)
    }
    expect(row(target).isPremium).toBe(0)
    // The same answer as any unknown API path (the catch-all route).
    for (const [method, url] of [['GET', '/api/nope'], ['PATCH', '/api/admin/nope/x'], ['POST', '/api/boards/x/nope']] as const) {
      const e = call(method, url, bob)
      expect(await unknown(e), url).toEqual({ error: 'not found' })
      expect(e.status, url).toBe(404)
    }
    // Local mode has no accounts to manage: the local user gets the same 404.
    vi.stubEnv('WIREBENDER_MODE', 'local')
    const local = call('GET', '/api/admin/users', null)
    expect(await list(local)).toEqual({ error: 'not found' })
  })

  it('lists accounts newest first, without the local user', async () => {
    const admin = account('Admin', 100, true)
    const bob = account('Bob', 300)
    const cy = account('Cy', 200)
    createBoard(useDb(), fixture, 'import', 'Bob', bob, bob)
    const trashed = createBoard(useDb(), fixture, 'import', 'Bob', bob, bob)
    useDb().update(boards).set({ trashedAt: Date.now() }).where(eq(boards.id, trashed.id)).run()
    signIn(useDb(), 'google', { id: 'g-bob', name: 'Bob' }, bob)
    const e = call('GET', '/api/admin/users', admin)
    expect(await list(e)).toEqual([
      { id: bob, name: 'Bob', avatar: null, providers: ['github', 'google'], boards: 1, createdAt: 300, isPremium: false, isAdmin: false, suspendedAt: null, deletedAt: null },
      { id: cy, name: 'Cy', avatar: null, providers: ['github'], boards: 0, createdAt: 200, isPremium: false, isAdmin: false, suspendedAt: null, deletedAt: null },
      { id: admin, name: 'Admin', avatar: null, providers: ['github'], boards: 0, createdAt: 100, isPremium: true, isAdmin: true, suspendedAt: null, deletedAt: null }
    ])
  })

  it('sets and clears premium', async () => {
    const admin = account('Admin', 1, true)
    const bob = account('Bob', 2)
    expect(await patchAs(admin, bob, { premium: true }).result).toMatchObject({ id: bob, isPremium: true })
    expect(row(bob).isPremium).toBe(1)
    expect(await patchAs(admin, bob, { premium: false }).result).toMatchObject({ id: bob, isPremium: false })
    expect(row(bob).isPremium).toBe(0)
  })

  it('a bad body is 422; an unknown account or the local user is 404', async () => {
    const admin = account('Admin', 1, true)
    const bob = account('Bob', 2)
    for (const body of [{}, { premium: 'yes' }, { suspended: 1 }, [], 'x', { isAdmin: true, premium: true }, { premium: true, name: 'X' }]) {
      const p = patchAs(admin, bob, body)
      expect(await p.result, JSON.stringify(body)).toMatchObject({ errors: expect.any(Array) })
      expect(p.e.status).toBe(422)
    }
    // Nothing of a refused body was applied.
    expect(row(bob)).toMatchObject({ isAdmin: 0, isPremium: 0 })
    expect(await patchAs(admin, bob, { isAdmin: true }).result).toEqual({ errors: ['isAdmin: not something an admin can change (premium, suspended)'] })
    for (const id of ['nobody', 'local']) {
      const p = patchAs(admin, id, { premium: true })
      expect(await p.result).toEqual({ error: 'not found' })
      expect(p.e.status).toBe(404)
    }
  })

  it('suspend closes sockets and blocks sign-in', async () => {
    const admin = account('Admin', 1, true)
    const bob = account('Bob', 2)
    const { id } = createBoard(useDb(), fixture, 'import', 'Admin', admin, admin)
    const closed: Record<string, number[]> = { bob: [], admin: [] }
    const link = (who: string): PeerLink => ({ update: () => {}, awareness: () => {}, close: code => closed[who]!.push(code) })
    const room = openRoom(useDb(), id)!
    room.join('admin-peer', 'Admin', link('admin'), { role: 'owner', viaLink: false, authorId: admin })
    room.join('bob-peer', 'Bob', link('bob'), { role: 'edit', viaLink: true, authorId: bob })

    expect(await patchAs(admin, bob, { suspended: true }).result).toMatchObject({ id: bob, suspendedAt: expect.any(Number) })
    expect(closed).toEqual({ bob: [4403], admin: [] })
    expect(signIn(useDb(), 'github', { id: 'gh-Bob', name: 'Bob' })).toEqual({ ok: false, reason: 'suspended' })
    // A session already open counts as anonymous.
    session = { user: { id: bob } }
    expect(await whoIs({ node: { req: { headers: { cookie: 'nuxt-auth-session=x' } } } } as never, { mode: 'public' })).toEqual({ kind: 'anonymous' })

    // Suspended again: the first date stays. Unsuspend lets them back in.
    const first = row(bob).suspendedAt
    await patchAs(admin, bob, { suspended: true }).result
    expect(row(bob).suspendedAt).toBe(first)
    expect(await patchAs(admin, bob, { suspended: false }).result).toMatchObject({ id: bob, suspendedAt: null })
    expect(signIn(useDb(), 'github', { id: 'gh-Bob', name: 'Bob' })).toEqual({ ok: true, userId: bob })
  })

  it('a suspended owner\'s links are 404 and their boards\' sockets close; unsuspend brings them back (R10)', async () => {
    const admin = account('Admin', 1, true)
    const bob = account('Bob', 2)
    const cy = account('Cy', 3)
    const { id } = createBoard(useDb(), fixture, 'import', 'Bob', bob, bob)
    useDb().update(boards).set({ visibility: 'edit' }).where(eq(boards.id, id)).run()
    const linkId = useDb().select().from(boards).where(eq(boards.id, id)).get()!.linkId
    const cyWho: Who = { kind: 'user', userId: cy, author: 'Cy', isAdmin: false, isPremium: false }
    const opened = access(useDb(), cyWho, linkId, [])
    expect(opened).toMatchObject({ ok: true, role: 'edit' })
    recordVisit(useDb(), cyWho, opened as Access & { ok: true }, linkId)
    expect(listShared(useDb(), cy)).toHaveLength(1)

    const closed: number[] = []
    const link: PeerLink = { update: () => {}, awareness: () => {}, close: code => closed.push(code) }
    openRoom(useDb(), id)!.join('cy-peer', 'Cy', link, { role: 'edit', viaLink: true, authorId: cy })

    await patchAs(admin, bob, { suspended: true }).result
    expect(closed).toEqual([4403])
    expect(access(useDb(), cyWho, linkId, [])).toEqual({ ok: false, status: 404 })
    expect(access(useDb(), { kind: 'anonymous' }, linkId, [])).toEqual({ ok: false, status: 404 })
    expect(listShared(useDb(), cy)).toEqual([])

    await patchAs(admin, bob, { suspended: false }).result
    expect(access(useDb(), cyWho, linkId, [])).toMatchObject({ ok: true, role: 'edit' })
    expect(listShared(useDb(), cy)).toHaveLength(1)
  })

  it('admin can\'t suspend themselves', async () => {
    const admin = account('Admin', 1, true)
    const p = patchAs(admin, admin, { suspended: true })
    expect(await p.result).toEqual({ error: 'You can\'t suspend your own account.' })
    expect(p.e.status).toBe(400)
    expect(row(admin).suspendedAt).toBeNull()
    // Their own premium flag is theirs to change.
    expect(await patchAs(admin, admin, { premium: false }).result).toMatchObject({ isPremium: false })
  })
})
