// The bundle routes' own wiring (status, content type, body cap, admin gate), with Nitro's helpers stubbed
// as in admin.test.ts. The logic behind them is in bundles.test.ts.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_BUNDLE_BYTES, encodeBundle } from '../../core/bundle'
import type { BoardFile } from '../../core/schema'
import { closeDb, useDb } from '../../server/db'
import { boards } from '../../server/db/schema'
import type { NodeReqLike } from '../../server/utils/peerAddress'
import { EXPORTS_PER_MINUTE, TOO_MANY_EXPORTS, resetExportRate } from '../../server/utils/bundles'
import { resetCreateRate } from '../../server/utils/lifecycle'
import type { Who } from '../../server/utils/who'

interface FakeEvent { node: { req: NodeReqLike }, method: string, path: string, context: Record<string, unknown>, status?: number, headers: Record<string, string> }

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (e: { statusCode: number, statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
  event.status = status
})
vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: string) => {
  event.headers[name] = value
})
vi.stubGlobal('setResponseHeaders', (event: FakeEvent, h: Record<string, string>) => Object.assign(event.headers, h))
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.node.req.headers[name])
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => (event.context.params as Record<string, string> | undefined)?.[name])

type Handler = (event: FakeEvent) => unknown
let importRoute: Handler
let adminExport: Handler
let meExport: Handler
let bundleRoute: Handler
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
const zip = encodeBundle({ name: 'Routed', exportedAt: 1, board: fixture, revisions: [] })
let dir: string

beforeAll(async () => {
  importRoute = (await import('../../server/api/boards/import-bundle.post')).default as unknown as Handler
  adminExport = (await import('../../server/api/admin/export.get')).default as unknown as Handler
  meExport = (await import('../../server/api/me/export.get')).default as unknown as Handler
  bundleRoute = (await import('../../server/api/boards/[id]/bundle.get')).default as unknown as Handler
})
afterAll(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  resetCreateRate()
  resetExportRate()
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-bundle-routes-'))
  vi.stubEnv('WIREBENDER_DATA', dir)
  vi.stubEnv('WIREBENDER_MODE', 'local')
})
afterEach(() => {
  closeDb()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const local: Who = { kind: 'local', userId: 'local', author: 'Local' }
const user = (isAdmin: boolean): Who => ({ kind: 'user', userId: 'u1', author: 'Ann', isAdmin, isPremium: false })

function call(method: string, who: Who, headers: Record<string, string>, chunks: Buffer[] = [], params: Record<string, string> = {}): FakeEvent & { read: () => number } {
  let read = 0
  const req = Object.assign(
    { method, socket: { remoteAddress: '127.0.0.1', localPort: 3003 }, headers },
    { async* [Symbol.asyncIterator]() {
      for (const c of chunks) {
        read++
        yield c
      }
    } }
  )
  return { node: { req }, method, path: '/', context: { who, params }, headers: {}, read: () => read }
}

describe('POST /api/boards/import-bundle', () => {
  it('answers 401 to anonymous', async () => {
    await expect(Promise.resolve(importRoute(call('POST', { kind: 'anonymous' }, { 'content-type': 'application/zip' })))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('answers 415 to any other content type, before reading the body', async () => {
    for (const type of ['text/plain', 'application/json', '']) {
      const e = call('POST', local, type ? { 'content-type': type } : {}, [Buffer.from(zip)])
      expect(await importRoute(e)).toEqual({ error: 'send the bundle as application/zip' })
      expect(e.status).toBe(415)
      expect(e.read()).toBe(0)
    }
  })

  it('answers 413 from the content-length without reading the body', async () => {
    const e = call('POST', local, { 'content-type': 'application/zip', 'content-length': String(MAX_BUNDLE_BYTES + 1) }, [Buffer.from(zip)])
    await importRoute(e)
    expect(e.status).toBe(413)
    expect(e.headers.connection).toBe('close')
    expect(e.read()).toBe(0)
  })

  it('answers 413 when the body streams past the cap with no content-length', async () => {
    const e = call('POST', local, { 'content-type': 'application/zip' }, [Buffer.alloc(MAX_BUNDLE_BYTES + 1), Buffer.alloc(10)])
    await importRoute(e)
    expect(e.status).toBe(413)
    expect(e.read()).toBe(1)
    expect(useDb().select().from(boards).all()).toHaveLength(0)
  })

  it('creates a board (201) from application/zip, with a charset, or application/octet-stream', async () => {
    for (const type of ['application/octet-stream', 'application/zip; charset=binary', 'Application/ZIP']) {
      const e = call('POST', local, { 'content-type': type, 'content-length': String(zip.length) }, [Buffer.from(zip.subarray(0, 100)), Buffer.from(zip.subarray(100))])
      expect(await importRoute(e)).toMatchObject({ name: fixture.name, head: 1, revisions: 0 })
      expect(e.status).toBe(201)
    }
    expect(useDb().select().from(boards).all()).toHaveLength(3)
  })

  it('answers 422 to a body that is not a bundle', async () => {
    const e = call('POST', local, { 'content-type': 'application/zip' }, [Buffer.from('not a zip')])
    expect(await importRoute(e)).toEqual({ error: expect.any(String) })
    expect(e.status).toBe(422)
  })
})

describe('the export routes', () => {
  it('the admin export answers 404 to a non-admin, anonymous and the local user, and 403 to a token', async () => {
    for (const who of [user(false), { kind: 'anonymous' } as Who, local]) {
      const e = call('GET', who, {})
      expect(await adminExport(e)).toEqual({ error: 'not found' })
      expect(e.status).toBe(404)
    }
    const e = call('GET', user(true), { authorization: 'Bearer wb_x' })
    expect(await adminExport(e)).toEqual({ error: 'Not allowed with a token.' })
    expect(e.status).toBe(403)
  })

  it('the admin export serves the zip to an admin', async () => {
    const e = call('GET', user(true), {})
    expect(await adminExport(e)).toBeInstanceOf(Uint8Array)
    expect(e.status).toBe(200)
    expect(e.headers['content-type']).toBe('application/zip')
  })

  it('download-all answers 401 to anonymous and a zip to the local user', async () => {
    const anon = call('GET', { kind: 'anonymous' }, {})
    await meExport(anon)
    expect(anon.status).toBe(401)
    const e = call('GET', local, {})
    expect(await meExport(e)).toBeInstanceOf(Uint8Array)
    expect(e.status).toBe(200)
  })

  it('the 7th bundle in a minute is 429, counted per client address for a signed-out visitor', async () => {
    const db = useDb()
    const created = await importRoute(call('POST', local, { 'content-type': 'application/zip' }, [Buffer.from(zip)])) as { id: string }
    db.update(boards).set({ visibility: 'view' }).where(eq(boards.id, created.id)).run()
    const linkId = db.select().from(boards).where(eq(boards.id, created.id)).get()!.linkId
    const from = (address: string) => {
      const e = call('GET', { kind: 'anonymous' }, {}, [], { id: linkId })
      e.node.req.socket = { remoteAddress: address, localPort: 3003 }
      return e
    }
    for (let i = 0; i < EXPORTS_PER_MINUTE; i++) {
      const e = from('203.0.113.7')
      expect(await bundleRoute(e)).toBeInstanceOf(Uint8Array)
      expect(e.status).toBe(200)
    }
    const seventh = from('203.0.113.7')
    expect(await bundleRoute(seventh)).toEqual({ error: TOO_MANY_EXPORTS })
    expect(seventh.status).toBe(429)
    const other = from('203.0.113.8')
    await bundleRoute(other)
    expect(other.status).toBe(200)
  })

  it('a bundle of an unknown board is 404', async () => {
    const e = call('GET', local, {}, [], { id: 'nope' })
    await bundleRoute(e)
    expect(e.status).toBe(404)
  })
})
