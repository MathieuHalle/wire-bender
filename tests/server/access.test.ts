import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, type Db } from '../../server/db'
import {
  checkMode, completePairing, gate, isLoopback, listDevices, MODE_ERROR, PAIR_TTL_MS, resetPairing, startPairing, trust, unpair
} from '../../server/utils/access'
import { PEER_HEADER, remoteOf, stampPeer, type NodeReqLike } from '../../server/utils/peerAddress'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-access-'))
  db = openDb(dir)
  resetPairing()
})
afterEach(() => {
  vi.useRealTimers()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A fake h3 event: only the Node request (socket and headers) is read. */
function event(remoteAddress: string | undefined, headers: Record<string, string> = {}) {
  const req: NodeReqLike = { socket: { remoteAddress, localPort: 3002 }, headers }
  return { node: { req } }
}

/** The `wb_device` token from a Set-Cookie value. */
function token(cookie: string): string {
  return /^wb_device=([^;]+)/.exec(cookie)![1]!
}

function pair(name = 'iPad', remote = '192.168.1.20'): string {
  const { code } = startPairing(3002)
  const r = completePairing(code, name, remote, db)
  if (!r.ok) throw new Error(`pairing failed: ${r.status}`)
  return r.cookie
}

describe('checkMode', () => {
  it('local passes; unset, public or foo throws the exact message', () => {
    expect(() => checkMode({ WIREBENDER_MODE: 'local' })).not.toThrow()
    for (const env of [{}, { WIREBENDER_MODE: 'public' }, { WIREBENDER_MODE: 'foo' }]) {
      expect(() => checkMode(env)).toThrow(MODE_ERROR)
    }
    expect(MODE_ERROR).toBe('public mode arrives in step 2; set WIREBENDER_MODE=local')
  })
})

describe('trust', () => {
  it('loopback is trusted, a LAN address is not', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopback(a)).toBe(true)
      expect(trust(event(a), db)).toEqual({ ok: true, author: 'Local · This computer' })
    }
    for (const a of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', '0.0.0.0', '', undefined]) {
      expect(isLoopback(a)).toBe(false)
      expect(trust(event(a), db)).toEqual({ ok: false })
    }
  })

  it('forwarded header does not make a request local', () => {
    expect(trust(event('192.168.1.20', { 'x-forwarded-for': '127.0.0.1' }), db)).toEqual({ ok: false })
    expect(trust(event('192.168.1.20', { 'x-real-ip': '127.0.0.1', 'host': 'localhost', 'forwarded': 'for=127.0.0.1' }), db)).toEqual({ ok: false })
  })

  it('a valid device cookie is trusted as the device, and lastSeen is updated', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const cookie = pair('Bench tablet')
    vi.setSystemTime(1_000_000 + 3_600_000)
    expect(trust(event('192.168.1.20', { cookie: `other=1; wb_device=${token(cookie)}` }), db)).toMatchObject({ ok: true, author: 'Local · Bench tablet' })
    expect(listDevices(db)[0]!.lastSeen).toBe(1_000_000 + 3_600_000)
  })

  it('a wrong or malformed cookie is not trusted', () => {
    pair()
    for (const c of ['wb_device=nope', 'wb_device=', 'wb_device', `wb_device=${'A'.repeat(43)}`]) {
      expect(trust(event('192.168.1.20', { cookie: c }), db)).toEqual({ ok: false })
    }
  })

  it('the cookie is httpOnly, SameSite=Lax, a year long; only the token\'s hash is stored', () => {
    const cookie = pair()
    expect(cookie).toMatch(/^wb_device=[\w-]{43}; /)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=31536000')
    expect(cookie).toContain('Path=/')
    const raw = db.$client.prepare('SELECT token_hash FROM devices').get() as { token_hash: string }
    expect(raw.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(raw.token_hash).not.toContain(token(cookie))
  })
})

describe('pairing', () => {
  it('a code is 6 digits; the url is the machine\'s LAN address and port with /pair', () => {
    const p = startPairing(3002)
    expect(p.code).toMatch(/^\d{6}$/)
    expect(p.url).toMatch(/^http:\/\/(\d{1,3}\.){3}\d{1,3}:3002\/pair$/)
    expect(p.url).not.toContain('127.0.0.1')
    expect(p.expiresAt - Date.now()).toBeGreaterThan(PAIR_TTL_MS - 1000)
  })

  it('pairing code works once and expires', () => {
    vi.useFakeTimers({ now: 5_000_000 })
    const { code } = startPairing(3002)
    expect(completePairing(code, 'iPad', '192.168.1.20', db)).toMatchObject({ ok: true })
    expect(completePairing(code, 'iPad', '192.168.1.20', db)).toEqual({ ok: false, status: 400 })
    const next = startPairing(3002)
    vi.advanceTimersByTime(10 * 60_000 + 1000)
    expect(completePairing(next.code, 'iPad', '192.168.1.21', db)).toEqual({ ok: false, status: 400 })
    expect(listDevices(db)).toHaveLength(1)
  })

  it('five wrong codes then 429', () => {
    vi.useFakeTimers({ now: 5_000_000 })
    const { code } = startPairing(3002)
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 5; i++) expect(completePairing(wrong, 'iPad', '192.168.1.20', db)).toEqual({ ok: false, status: 400 })
    // Even the right code is refused from that address now; another address still works.
    expect(completePairing(code, 'iPad', '192.168.1.20', db)).toEqual({ ok: false, status: 429 })
    expect(completePairing(wrong, 'iPad', '192.168.1.30', db)).toEqual({ ok: false, status: 400 })
    // The window resets after 10 minutes.
    vi.advanceTimersByTime(10 * 60_000 + 1000)
    const again = startPairing(3002)
    expect(completePairing(again.code, 'iPad', '192.168.1.20', db)).toMatchObject({ ok: true })
  })

  it('wrong codes from many addresses burn the code', () => {
    const { code } = startPairing(3002)
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 20; i++) completePairing(wrong, 'x', `192.168.2.${i}`, db)
    expect(completePairing(code, 'iPad', '192.168.3.1', db)).toEqual({ ok: false, status: 400 })
  })

  it('a new code replaces the old one', () => {
    const first = startPairing(3002)
    let second = startPairing(3002)
    while (second.code === first.code) second = startPairing(3002)
    expect(completePairing(first.code, 'iPad', '192.168.1.20', db)).toEqual({ ok: false, status: 400 })
    expect(completePairing(second.code, 'iPad', '192.168.1.20', db)).toMatchObject({ ok: true })
  })

  it('a bad device name is 400 and does not use the code', () => {
    const { code } = startPairing(3002)
    for (const name of ['', '   ', 'x'.repeat(41)]) expect(completePairing(code, name, '192.168.1.20', db)).toEqual({ ok: false, status: 400 })
    expect(completePairing(code, '  iPad  ', '192.168.1.20', db)).toMatchObject({ ok: true })
    expect(listDevices(db)[0]!.name).toBe('iPad')
  })

  it('unpair revokes the cookie', () => {
    const cookie = pair()
    const req = event('192.168.1.20', { cookie: `wb_device=${token(cookie)}` })
    expect(trust(req, db).ok).toBe(true)
    const [device] = listDevices(db)
    expect(unpair(db, device!.id)).toBe(true)
    expect(trust(req, db)).toEqual({ ok: false })
    expect(listDevices(db)).toEqual([])
    expect(unpair(db, device!.id)).toBe(false)
  })
})

describe('gate', () => {
  it('trusted requests pass', () => {
    expect(gate('GET', '/api/boards', true)).toBe('pass')
    expect(gate('GET', '/b/x', true)).toBe('pass')
  })

  it('untrusted: 401 from the API (except POST /api/pair), /pair for pages', () => {
    expect(gate('POST', '/api/pair', false)).toBe('pass')
    expect(gate('POST', '/api/pair?x=1', false)).toBe('pass')
    expect(gate('GET', '/pair', false)).toBe('pass')
    expect(gate('GET', '/_nuxt/entry.js', false)).toBe('pass')
    for (const [m, p] of [['GET', '/api/boards'], ['POST', '/api/pair/start'], ['GET', '/api/pair'], ['GET', '/api/devices'], ['DELETE', '/api/devices/x'], ['GET', '/_ws/board/x'], ['POST', '/b/x'], ['GET', '/_nuxt/../api/boards'], ['GET', '//api/boards']] as const) {
      expect(gate(m, p, false), `${m} ${p}`).toBe('deny')
    }
    for (const p of ['/', '/b/x', '/pair/x', '/pairs']) expect(gate('GET', p, false), p).toBe('redirect')
  })
})

describe('peer address through the dev proxy', () => {
  const secret = 'a'.repeat(64)

  it('the socket address wins over any header', () => {
    const req: NodeReqLike = { socket: { remoteAddress: '192.168.1.20', localPort: 3002 }, headers: { [PEER_HEADER]: `${secret} 127.0.0.1 3002` } }
    expect(remoteOf(req, secret)).toEqual({ address: '192.168.1.20', port: 3002 })
  })

  it('without a socket address, only a header stamped with the secret counts', () => {
    const bare = (h: Record<string, string>): NodeReqLike => ({ socket: {}, headers: h })
    expect(remoteOf(bare({}), secret).address).toBeUndefined()
    expect(remoteOf(bare({ 'x-forwarded-for': '127.0.0.1' }), secret).address).toBeUndefined()
    expect(remoteOf(bare({ [PEER_HEADER]: `${'b'.repeat(64)} 127.0.0.1 3002` }), secret).address).toBeUndefined()
    expect(remoteOf(bare({ [PEER_HEADER]: `${secret} 127.0.0.1 3002` }), undefined).address).toBeUndefined()
    expect(remoteOf(bare({ [PEER_HEADER]: `${secret} 127.0.0.1 3002` }), secret)).toEqual({ address: '127.0.0.1', port: 3002 })
  })

  it('stamping overwrites what the client sent', () => {
    const req = { socket: { remoteAddress: '192.168.1.20', localPort: 3002 }, headers: { [PEER_HEADER]: `${secret} 127.0.0.1 3002` } as Record<string, string | string[] | undefined> }
    stampPeer(req, secret)
    expect(req.headers[PEER_HEADER]).toBe(`${secret} 192.168.1.20 3002`)
    const viaProxy: NodeReqLike = { socket: {}, headers: req.headers }
    expect(remoteOf(viaProxy, secret).address).toBe('192.168.1.20')
  })
})
