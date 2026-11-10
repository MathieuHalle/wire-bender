import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, type Db } from '../../server/db'
import {
  completePairing, gate, isLoopback, lanAddress, legacyRedirect, listDevices, PAIR_TTL_MS, refusal, resetPairing, startPairing, trust, unpair
} from '../../server/utils/access'
import { PEER_HEADER, remoteOf, stampPeer, stampSecret, type NodeReqLike } from '../../server/utils/peerAddress'

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

/** A fake h3 event: only the Node request (method, socket and headers) is read. */
function event(remoteAddress: string | undefined, headers: Record<string, string> = {}, method = 'GET') {
  const req: NodeReqLike = { method, socket: { remoteAddress, localPort: 3002 }, headers }
  return { node: { req } }
}

/** The machine's first non-internal IPv4 address (the tests need one). */
function lanIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address
  }
  throw new Error('no LAN address')
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
    for (const name of ['', '   ', 'x'.repeat(41), 'This computer', '  this COMPUTER ', 'This\u200b computer'.replace('\u200b', ''), '\u200b\u202e']) {
      expect(completePairing(code, name, '192.168.1.20', db), JSON.stringify(name)).toEqual({ ok: false, status: 400 })
    }
    expect(completePairing(code, 'This\u200b computer', '192.168.1.20', db)).toEqual({ ok: false, status: 400 })
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

  it('in production the socket address wins over any header', () => {
    const req: NodeReqLike = { socket: { remoteAddress: '192.168.1.20', localPort: 3002 }, headers: { [PEER_HEADER]: `${secret} 127.0.0.1 3002` } }
    expect(remoteOf(req, secret, false)).toEqual({ address: '192.168.1.20', port: 3002 })
  })

  it('dev, socket 127.0.0.1, no stamp → untrusted (a dev worker on TCP sees only the proxy)', () => {
    const req: NodeReqLike = { socket: { remoteAddress: '127.0.0.1', localPort: 41234 }, headers: {} }
    expect(remoteOf(req, secret, true)).toEqual({ address: undefined, port: undefined })
    const forged: NodeReqLike = { socket: { remoteAddress: '127.0.0.1', localPort: 41234 }, headers: { [PEER_HEADER]: `${'b'.repeat(64)} 127.0.0.1 3002` } }
    expect(remoteOf(forged, secret, true).address).toBeUndefined()
  })

  it('dev, valid stamp → stamped address, whatever the socket says', () => {
    const req: NodeReqLike = { socket: { remoteAddress: '127.0.0.1', localPort: 41234 }, headers: { [PEER_HEADER]: `${secret} 192.168.1.20 3002` } }
    expect(remoteOf(req, secret, true)).toEqual({ address: '192.168.1.20', port: 3002 })
  })

  it('outside dev a stamp is never accepted, even with the secret', () => {
    const req: NodeReqLike = { socket: {}, headers: { [PEER_HEADER]: `${secret} 127.0.0.1 3002` } }
    expect(remoteOf(req, secret, false).address).toBeUndefined()
    expect(remoteOf(req, secret).address).toBeUndefined()
  })

  it('without a socket address, only a header stamped with the secret counts', () => {
    const bare = (h: Record<string, string>): NodeReqLike => ({ socket: {}, headers: h })
    expect(remoteOf(bare({}), secret, true).address).toBeUndefined()
    expect(remoteOf(bare({ 'x-forwarded-for': '127.0.0.1' }), secret, true).address).toBeUndefined()
    expect(remoteOf(bare({ [PEER_HEADER]: `${'b'.repeat(64)} 127.0.0.1 3002` }), secret, true).address).toBeUndefined()
    expect(remoteOf(bare({ [PEER_HEADER]: `${secret} 127.0.0.1 3002` }), undefined, true).address).toBeUndefined()
    expect(remoteOf(bare({ [PEER_HEADER]: `${secret} 127.0.0.1 3002` }), secret, true)).toEqual({ address: '127.0.0.1', port: 3002 })
  })

  it('stamping overwrites what the client sent', () => {
    const req = { socket: { remoteAddress: '192.168.1.20', localPort: 3002 }, headers: { [PEER_HEADER]: `${secret} 127.0.0.1 3002` } as Record<string, string | string[] | undefined> }
    stampPeer(req, secret)
    expect(req.headers[PEER_HEADER]).toBe(`${secret} 192.168.1.20 3002`)
    const viaProxy: NodeReqLike = { socket: {}, headers: req.headers }
    expect(remoteOf(viaProxy, secret, true).address).toBe('192.168.1.20')
  })

  it('refuses to stamp a connection without a socket address: the client\'s stamp is dropped', () => {
    const req = { socket: {}, headers: { [PEER_HEADER]: `${secret} 127.0.0.1 3002` } as Record<string, string | string[] | undefined> }
    stampPeer(req, secret)
    expect(req.headers[PEER_HEADER]).toBeUndefined()
    expect(remoteOf({ socket: {}, headers: req.headers }, secret, true).address).toBeUndefined()
  })

  it('a listener that is not on TCP stamps nothing: the client\'s stamp is dropped', () => {
    expect(stampSecret('/tmp/nuxt.sock', secret)).toBeNull()
    expect(stampSecret(null, secret)).toBeNull()
    expect(stampSecret({ address: '::', family: 'IPv6', port: 3002 }, secret)).toBe(secret)
    const req = { socket: { remoteAddress: '192.168.1.20', localPort: 3002 }, headers: { [PEER_HEADER]: `${secret} 127.0.0.1 3002` } as Record<string, string | string[] | undefined> }
    stampPeer(req, stampSecret('/tmp/nuxt.sock', secret))
    expect(req.headers[PEER_HEADER]).toBeUndefined()
  })
})

describe('refusal: Host and Origin checks only deny', () => {
  it('rebinding Host from loopback is 403', () => {
    expect(refusal(event('127.0.0.1', { host: 'evil.example:3002' }))).toBe(403)
    expect(refusal(event('127.0.0.1', { host: 'evil.example' }))).toBe(403)
    expect(refusal(event('127.0.0.1', {}))).toBe(403)
  })

  it('a known host on another port is 403', () => {
    expect(refusal(event('127.0.0.1', { host: 'localhost:3999' }))).toBe(403)
  })

  it('cross-origin POST /api/boards is 403', () => {
    expect(refusal(event('127.0.0.1', { host: 'localhost:3002', origin: 'http://evil.example' }, 'POST'))).toBe(403)
    expect(refusal(event('127.0.0.1', { host: 'localhost:3002', origin: 'null' }, 'POST'))).toBe(403)
    expect(refusal(event('127.0.0.1', { host: 'localhost:3002', origin: 'http://localhost:3003' }, 'DELETE'))).toBe(403)
  })

  it('cross-origin WebSocket upgrade is refused', () => {
    const upgrade = { _req: { method: 'GET', socket: { remoteAddress: '127.0.0.1', localPort: 3002 }, headers: { host: 'localhost:3002', upgrade: 'websocket', origin: 'http://evil.example' } } }
    expect(refusal(upgrade)).toBe(403)
    const same = { _req: { ...upgrade._req, headers: { ...upgrade._req.headers, origin: 'http://localhost:3002' } } }
    expect(refusal(same)).toBeNull()
  })

  it('same-origin LAN-IP Host from a paired device is ok', () => {
    const cookie = pair()
    const ip = lanIp()
    const req = event('192.168.1.20', { host: `${ip}:3002`, origin: `http://${ip}:3002`, cookie: `wb_device=${token(cookie)}` }, 'POST')
    expect(refusal(req)).toBeNull()
    expect(trust(req, db).ok).toBe(true)
  })

  it('loopback with Host localhost and no Origin is ok', () => {
    expect(refusal(event('127.0.0.1', { host: 'localhost:3002' }))).toBeNull()
    expect(refusal(event('127.0.0.1', { host: 'localhost:3002' }, 'POST'))).toBeNull()
    expect(refusal(event('127.0.0.1', { host: '127.0.0.1:3002' }))).toBeNull()
    expect(refusal(event('::1', { host: '[::1]:3002' }))).toBeNull()
    expect(refusal(event('127.0.0.1', { host: `${os.hostname()}:3002` }))).toBeNull()
    expect(refusal(event('127.0.0.1', { host: 'LOCALHOST' }))).toBeNull()
  })

  it('a cross-origin GET is allowed (it reads nothing it could not already)', () => {
    expect(refusal(event('127.0.0.1', { host: 'localhost:3002', origin: 'http://evil.example' }))).toBeNull()
  })
})

describe('lanAddress', () => {
  const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null })

  it('lanAddress skips utun and 100.64/10', () => {
    expect(lanAddress({ lo0: [v4('127.0.0.1', true)], utun4: [v4('10.8.0.2')], tailscale0: [v4('100.101.1.1')], bridge100: [v4('192.168.64.1')], en0: [v4('192.168.1.5')] })).toBe('192.168.1.5')
    // A CGNAT address on a preferred name is skipped; another interface is used.
    expect(lanAddress({ en5: [v4('100.64.3.4')], docker0: [v4('172.17.0.1')], vboxnet0: [v4('192.168.56.1')], wlan0: [v4('192.168.0.9')] })).toBe('192.168.0.9')
    expect(lanAddress({ utun2: [v4('10.0.0.7')], foo0: [v4('10.1.2.3')] })).toBe('10.1.2.3')
    // Nothing better: the old rule (the first non-internal IPv4).
    expect(lanAddress({ lo0: [v4('127.0.0.1', true)], utun0: [v4('10.0.0.7')] })).toBe('10.0.0.7')
    expect(lanAddress({ lo0: [v4('127.0.0.1', true)] })).toBeUndefined()
    expect(lanAddress({ eth0: [v4('100.127.255.1')], wl0: [v4('100.128.0.1')] })).toBe('100.128.0.1')
  })
})

describe('legacyRedirect', () => {
  it('moves the old pages, keeping the query', () => {
    expect(legacyRedirect('GET', '/account')).toBe('/settings/account')
    expect(legacyRedirect('GET', '/account?error=taken')).toBe('/settings/account?error=taken')
    expect(legacyRedirect('HEAD', '/admin')).toBe('/settings/admin')
    expect(legacyRedirect('GET', '/api')).toBe('/settings/connections')
  })
  it('leaves everything else alone', () => {
    for (const p of ['/api/', '/api/boards', '/api/me', '/apix', '/account/deleted', '/admin/x', '/', '/b/abc', '/pair', '/setup'])
      expect(legacyRedirect('GET', p), p).toBeNull()
    expect(legacyRedirect('POST', '/api')).toBeNull()
    expect(legacyRedirect('POST', '/account')).toBeNull()
  })
})
