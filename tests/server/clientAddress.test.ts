import { describe, expect, it } from 'vitest'
import { clientAddress, parseTrustProxy, TRUST_PROXY_ERROR } from '../../server/utils/clientAddress'

const req = (peer: string | undefined, xff?: string | string[]) => ({
  socket: peer ? { remoteAddress: peer, localPort: 3000 } : null,
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff }
})
const env = (trust?: string) => ({ WIREBENDER_MODE: 'public', ...(trust === undefined ? {} : { WIREBENDER_TRUST_PROXY: trust }) })

describe('parseTrustProxy', () => {
  it('reads addresses and ranges, comma-separated, IPv4 and IPv6', () => {
    const t = parseTrustProxy(' 172.30.0.0/24, 10.0.0.7 ,fd00::/8 ')
    expect(t?.check('172.30.0.9')).toBe(true)
    expect(t?.check('::ffff:172.30.0.9')).toBe(true)
    expect(t?.check('10.0.0.7')).toBe(true)
    expect(t?.check('10.0.0.8')).toBe(false)
    expect(t?.check('fd12::1')).toBe(true)
  })

  it('empty or unset trusts no proxy', () => {
    expect(parseTrustProxy(undefined)).toBeNull()
    expect(parseTrustProxy('  ')).toBeNull()
  })

  it('a wrong entry stops the server, naming it', () => {
    expect(() => parseTrustProxy('172.30.0.0/24,caddy')).toThrow(`${TRUST_PROXY_ERROR} caddy`)
    expect(() => parseTrustProxy('172.30.0.0/33')).toThrow(TRUST_PROXY_ERROR)
    expect(() => parseTrustProxy('1.2.3.4/x')).toThrow(TRUST_PROXY_ERROR)
  })
})

describe('clientAddress', () => {
  it('without WIREBENDER_TRUST_PROXY: the socket, whatever X-Forwarded-For says', () => {
    expect(clientAddress(req('172.30.0.2', '203.0.113.9'), env())).toBe('172.30.0.2')
  })

  it('from a trusted proxy: the last address in X-Forwarded-For that is not a proxy', () => {
    expect(clientAddress(req('172.30.0.2', '203.0.113.9'), env('172.30.0.0/24'))).toBe('203.0.113.9')
    // A visitor's own made-up entry sits on the left; Caddy appends the real one.
    expect(clientAddress(req('172.30.0.2', '1.1.1.1, 203.0.113.9'), env('172.30.0.0/24'))).toBe('203.0.113.9')
    // A chain of trusted proxies is skipped.
    expect(clientAddress(req('172.30.0.2', '203.0.113.9, 172.30.0.3'), env('172.30.0.0/24'))).toBe('203.0.113.9')
    // Several header lines count as one list.
    expect(clientAddress(req('172.30.0.2', ['203.0.113.9', '172.30.0.3']), env('172.30.0.0/24'))).toBe('203.0.113.9')
  })

  it('from anyone else: the header is ignored', () => {
    expect(clientAddress(req('198.51.100.4', '203.0.113.9'), env('172.30.0.0/24'))).toBe('198.51.100.4')
  })

  it('a trusted proxy with no usable header: the proxy itself', () => {
    expect(clientAddress(req('172.30.0.2'), env('172.30.0.0/24'))).toBe('172.30.0.2')
    expect(clientAddress(req('172.30.0.2', 'garbage, '), env('172.30.0.0/24'))).toBe('172.30.0.2')
    expect(clientAddress(req('172.30.0.2', '172.30.0.3'), env('172.30.0.0/24'))).toBe('172.30.0.3')
  })

  it('local mode never reads the header', () => {
    expect(clientAddress(req('127.0.0.1', '203.0.113.9'), { WIREBENDER_MODE: 'local', WIREBENDER_TRUST_PROXY: '127.0.0.1' })).toBe('127.0.0.1')
  })

  it('no socket address: unknown', () => {
    expect(clientAddress(req(undefined, '203.0.113.9'), env('172.30.0.0/24'))).toBeUndefined()
  })
})
