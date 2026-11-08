// Local mode access (spec §3): the machine itself is trusted by its socket address, a
// paired device by its `wb_device` cookie. Nothing else is: no request header (Host,
// X-Forwarded-For and the like) ever makes a request local.
//
// Pairing codes and wrong-code counters live in memory; a restart drops them.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { eq } from 'drizzle-orm'
import { useDb, type Db } from '../db'
import { devices } from '../db/schema'
import { remoteOf, type NodeReqLike } from './peerAddress'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK.has(remoteAddress)
}

export const THIS_COMPUTER = 'This computer'
export const COOKIE = 'wb_device'
const COOKIE_MAX_AGE_S = 365 * 24 * 3600
/** lastSeen is written at most this often per device. */
const SEEN_EVERY_MS = 60_000

export type Trust = { ok: true, author: string, device?: { id: string, name: string } } | { ok: false }

/** Anything a request can be read from: an h3 event, a crossws upgrade request or a crossws peer. */
type FromEvent = { node: { req: NodeReqLike } }
type FromUpgrade = { _req?: NodeReqLike }
type FromPeer = { request?: { _req?: NodeReqLike } }
export type TrustSource = FromEvent | FromUpgrade | FromPeer

/**
 * The Node request behind a source. crossws (0.3, Node adapter) keeps it as `_req` on its
 * request proxy; if a future version stops doing so, nothing is trusted (fail closed).
 */
function nodeReq(source: TrustSource): NodeReqLike | undefined {
  if ('node' in source) return source.node.req
  if ('_req' in source && source._req) return source._req
  if ('request' in source) return source.request?._req
  return undefined
}

/**
 * The token of an `Authorization: Bearer <token>` header (an empty string for a bare
 * `Bearer`); undefined when the request sends no bearer header. Tokens come from this header
 * only: never a query string, a cookie or a body.
 */
export function bearerOf(source: TrustSource): string | undefined {
  const header = nodeReq(source)?.headers.authorization
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') return undefined
  const m = /^bearer(?:\s+(.*))?$/i.exec(value.trim())
  return m ? (m[1] ?? '').trim() : undefined
}

/** A cookie of a request, upgrade request or peer; undefined if it sent none by that name. */
export function cookieOf(source: TrustSource, name: string): string | undefined {
  return cookieValue(nodeReq(source)?.headers.cookie, name)
}

function cookieValue(header: string | string[] | undefined, name: string): string | undefined {
  const all = Array.isArray(header) ? header.join('; ') : header
  if (!all) return undefined
  for (const part of all.split(';')) {
    const eqAt = part.indexOf('=')
    if (eqAt > 0 && part.slice(0, eqAt).trim() === name) return part.slice(eqAt + 1).trim()
  }
  return undefined
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** The paired device a token belongs to, with its lastSeen bumped; null if none. */
function deviceFor(db: Db, token: string | undefined, now: number): { id: string, name: string } | null {
  if (!token || !/^[\w-]{43}$/.test(token)) return null
  const row = db.select().from(devices).where(eq(devices.tokenHash, hashToken(token))).get()
  if (!row) return null
  if (now - row.lastSeen >= SEEN_EVERY_MS) db.update(devices).set({ lastSeen: now }).where(eq(devices.id, row.id)).run()
  return { id: row.id, name: row.name }
}

/** Who a request is: the machine itself (loopback socket), a paired device (cookie), or no one. */
export function trust(source: TrustSource, db: Db = useDb()): Trust {
  const req = nodeReq(source)
  if (!req) return { ok: false }
  if (isLoopback(remoteOf(req).address)) return { ok: true, author: `Local · ${THIS_COMPUTER}` }
  const device = deviceFor(db, cookieValue(req.headers.cookie, COOKIE), Date.now())
  return device ? { ok: true, author: `Local · ${device.name}`, device } : { ok: false }
}

/** The server port a request came in on (for the pairing URL). */
export function portOf(source: TrustSource): number | undefined {
  const req = nodeReq(source)
  return req ? remoteOf(req).port : undefined
}

/** `Host` as hostname (lowercase, IPv6 without brackets) and port; null if malformed. */
function parseHost(host: string): { name: string, port: number | undefined } | null {
  const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(host) ?? /^([^:[\]\s/@]+)(?::(\d{1,5}))?$/.exec(host)
  if (!m) return null
  return { name: m[1]!.toLowerCase(), port: m[2] === undefined ? undefined : Number(m[2]) }
}

/** The names this machine may be reached by: localhost, its hostname (and `.local`), its own addresses. */
function ownNames(): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '::1'])
  const host = hostname().toLowerCase()
  if (host) {
    names.add(host)
    names.add(host.endsWith('.local') ? host.slice(0, -'.local'.length) : `${host}.local`)
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) names.add(i.address.toLowerCase())
  }
  return names
}

/** In public mode, `WIREBENDER_URL` (checked at start: the server does not run without it); null in local mode. */
function publicUrlFromEnv(): string | null {
  return process.env.WIREBENDER_MODE === 'public' ? process.env.WIREBENDER_URL ?? '' : null
}

const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 }

/** Public mode: Host must name `WIREBENDER_URL`'s host and port (a missing port is the scheme's own). */
function isPublicHost(host: { name: string, port: number | undefined }, publicUrl: string): boolean {
  let url: URL
  try {
    url = new URL(publicUrl)
  } catch {
    return false
  }
  const name = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  const port = url.port === '' ? DEFAULT_PORT[url.protocol] : Number(url.port)
  return port !== undefined && host.name === name && (host.port ?? DEFAULT_PORT[url.protocol]) === port
}

/**
 * 403 for a request that names another site, else null. These checks only ever deny;
 * trust is decided by `trust()` alone. They stop DNS rebinding (a page on evil.example
 * whose name now points at this machine: its Host is evil.example) and cross-site writes
 * (a page elsewhere posting to, or opening a live socket on, this server: its Origin is
 * another site). A missing Origin is allowed: curl, the CLI and AI clients send none.
 *
 * In public mode (`publicUrl` set) the site is `WIREBENDER_URL`'s host, not the machine's
 * own names: behind a reverse proxy the machine's names and port are not what people use.
 */
export function refusal(source: TrustSource, publicUrl: string | null = publicUrlFromEnv()): 403 | null {
  const req = nodeReq(source)
  if (!req) return 403
  const hostHeader = req.headers.host
  const host = typeof hostHeader === 'string' ? parseHost(hostHeader) : null
  if (!host) return 403
  if (publicUrl !== null) {
    if (!isPublicHost(host, publicUrl)) return 403
  } else {
    if (!ownNames().has(host.name)) return 403
    if (host.port !== undefined && host.port !== remoteOf(req).port) return 403
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const writes = req.headers.upgrade !== undefined || (method !== 'GET' && method !== 'HEAD')
  const origin = req.headers.origin
  if (writes && origin !== undefined) {
    let originHost: string
    try {
      originHost = new URL(String(origin)).host.toLowerCase()
    } catch {
      return 403
    }
    if (originHost === '' || originHost !== String(hostHeader).toLowerCase()) return 403
  }
  return null
}

export type Gate = 'pass' | 'deny' | 'redirect'

/** Paths an unpaired device may load: the pairing page and the app's own assets. */
const OPEN_PREFIXES = ['/_nuxt/', '/api/_nuxt_icon/']
const OPEN_FILES = new Set(['/pair', '/icon.svg', '/favicon.ico'])

/** What to do with a request: trusted passes; untrusted gets 401 from the API, /pair for pages. */
export function gate(method: string, path: string, trusted: boolean): Gate {
  if (trusted) return 'pass'
  const pathname = path.split('?')[0]!
  // Anything odd is refused outright: no allow-listed prefix may lead elsewhere.
  const plain = plainPath(pathname)
  if (plain && method === 'POST' && pathname === '/api/pair') return 'pass'
  const get = method === 'GET' || method === 'HEAD'
  if (plain && get && (OPEN_FILES.has(pathname) || OPEN_PREFIXES.some(p => pathname.startsWith(p)))) return 'pass'
  if (!plain || !get || pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/_')) return 'deny'
  return 'redirect'
}

/** A path with no odd segments ('..', '.', empty, unusual characters). */
function plainPath(pathname: string): boolean {
  return /^(\/[\w.~-]+)+\/?$|^\/$/.test(pathname) && !pathname.split('/').some(s => s === '..' || s === '.')
}

export type PublicGate = 'pass' | 'deny' | 'not-found' | 'account'

/** Pairing is local mode's: in public mode these routes do not exist. */
const PAIRING = /^\/(pair|api\/pair|api\/devices)(\/|$)/

/**
 * The board edits, the link unlock and the setup code (entered before the first admin signs
 * in) an anonymous visitor may send on to their route.
 */
const ANONYMOUS_WRITES: [string, RegExp][] = [
  ['PUT', /^\/api\/boards\/[^/]+$/],
  ['POST', /^\/api\/boards\/[^/]+\/(undo|redo)$/],
  ['POST', /^\/api\/boards\/[^/]+\/revisions\/[^/]+\/restore$/],
  ['POST', /^\/api\/links\/[^/]+\/unlock$/],
  ['POST', /^\/api\/setup$/]
]

function anonymousWrite(method: string, pathname: string): boolean {
  const path = pathname.replace(/\/$/, '')
  return ANONYMOUS_WRITES.some(([m, re]) => m === method && re.test(path))
}

/**
 * The routes a token may not use (step 3): account deletion and restore, deleting a board for
 * good, its sharing, the tokens themselves, the admin and the setup code. `*` is any method.
 * Also sign-in (`/auth/*`, which from a signed-in caller links another identity to the
 * account) and nuxt-auth-utils' cookie session routes (`/api/_auth/*`).
 */
const TOKEN_DENIED: [string, RegExp][] = [
  ['DELETE', /^\/api\/me$/],
  ['POST', /^\/api\/me\/restore$/],
  ['DELETE', /^\/api\/boards\/[^/]+$/],
  ['PATCH', /^\/api\/boards\/[^/]+\/sharing$/],
  ['POST', /^\/api\/boards\/[^/]+\/sharing\/regenerate$/],
  ['*', /^\/api\/tokens(\/.*)?$/],
  ['*', /^\/api\/admin(\/.*)?$/],
  ['POST', /^\/api\/setup$/],
  ['*', /^\/auth(\/.*)?$/],
  ['*', /^\/api\/_auth(\/.*)?$/]
]

export const TOKEN_REFUSED = 'Not allowed with a token.'

/**
 * Whether a request made with a token is refused (403 `Not allowed with a token.`). A path
 * with odd segments or characters is refused too, so no spelling of a denied route gets by.
 */
export function tokenRefusal(path: string, method: string): boolean {
  const pathname = path.split('?')[0]!
  if (!plainPath(pathname)) return true
  const p = pathname.toLowerCase().replace(/\/$/, '')
  const m = method.toUpperCase()
  return TOKEN_DENIED.some(([dm, re]) => (dm === '*' || dm === m) && re.test(p))
}

/** What anonymous may read in public mode, besides pages: the board routes decide per board. */
function anonymousRead(pathname: string): boolean {
  return pathname === '/api/me' || pathname === '/api/_auth/session'
    || pathname.startsWith('/api/boards/') || pathname.startsWith('/auth/')
    || OPEN_PREFIXES.some(p => pathname.startsWith(p))
    || !(pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/_'))
}

/**
 * Public mode (spec §3): anyone may load pages, `GET /api/me`, sign-in (`/auth/*`) and the
 * board read routes; everything else needs a signed-in user. A session of a deleted
 * account waiting for its restore (ruling R1) is sent to /account for every page, and may
 * send `POST /api/me/restore`. Signing out is always allowed.
 */
export function publicGate(method: string, path: string, signedIn: boolean, pendingDeletion = false): PublicGate {
  const pathname = path.split('?')[0]!
  // An odd path ('..', '//', escapes) is refused before anything else: a signed-in user gets
  // the 404 of any unknown address, never "Sign in first.".
  if (!plainPath(pathname)) return signedIn ? 'not-found' : 'deny'
  if (PAIRING.test(pathname)) return 'not-found'
  if (method === 'DELETE' && pathname === '/api/_auth/session') return 'pass'
  if (signedIn) return 'pass'
  // R1: the one write a deleted account's session may send (its route reads the session itself).
  if (pendingDeletion && method === 'POST' && pathname === '/api/me/restore') return 'pass'
  // The board's own route decides these per board: 404, or 403 "Sign in to edit." on an edit link.
  if (anonymousWrite(method, pathname)) return 'pass'
  const get = method === 'GET' || method === 'HEAD'
  if (!get || !anonymousRead(pathname)) return 'deny'
  const page = !(pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/_') || pathname.startsWith('/auth/') || OPEN_FILES.has(pathname))
  if (pendingDeletion && page && pathname !== '/account') return 'account'
  return 'pass'
}

// Pairing.

export const PAIR_TTL_MS = 10 * 60_000
const MAX_WRONG_PER_ADDRESS = 5
/** Wrong codes from all addresses together that use up the current code. */
const MAX_WRONG_PER_CODE = 20
const MAX_NAME = 40

let current: { code: string, expiresAt: number, wrong: number } | null = null
const wrongBy = new Map<string, { count: number, since: number }>()

/** Tests only: forget the pending code and the wrong-code counters. */
export function resetPairing(): void {
  current = null
  wrongBy.clear()
}

/** Interface names that are usually the machine's own LAN (Ethernet or Wi-Fi). */
const LAN_NAMES = /^(en|eth|wlan|wl)/
/** Tunnels, VPNs, bridges and VMs: another device on the LAN cannot reach these. */
const NOT_LAN_NAMES = /^(utun|bridge|docker|vboxnet|tailscale)/

/** In 100.64.0.0/10 (carrier-grade NAT, used by Tailscale and other VPNs). */
function isCgnat(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b !== undefined && b >= 64 && b <= 127
}

/**
 * The address a phone on the same network should use for this machine: an IPv4 address on
 * an Ethernet or Wi-Fi interface first, then any other one that is not a tunnel, VPN,
 * bridge or VM, then (the old rule) the first non-internal IPv4 address.
 */
export function lanAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | undefined {
  const all = Object.entries(interfaces).flatMap(([name, list]) =>
    (list ?? []).filter(i => i.family === 'IPv4' && !i.internal).map(i => ({ name, address: i.address })))
  const usable = all.filter(i => !NOT_LAN_NAMES.test(i.name) && !isCgnat(i.address))
  return (usable.find(i => LAN_NAMES.test(i.name)) ?? usable[0] ?? all[0])?.address
}

/** A new single-use code (replacing any pending one). Call only for a trusted request. */
export function startPairing(port?: number): { code: string, expiresAt: number, url: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = Date.now() + PAIR_TTL_MS
  current = { code, expiresAt, wrong: 0 }
  const host = lanAddress() ?? 'localhost'
  return { code, expiresAt, url: `http://${host}${port ? `:${port}` : ''}/pair` }
}

export type PairResult = { ok: true, cookie: string, name: string } | { ok: false, status: 400 | 429 }

/** Pairs a device with the pending code; the cookie is its `Set-Cookie` value. */
export function completePairing(code: unknown, name: unknown, remote: string | undefined, db: Db = useDb()): PairResult {
  const now = Date.now()
  const key = remote ?? 'unknown'
  const seen = wrongBy.get(key)
  if (seen && now - seen.since > PAIR_TTL_MS) wrongBy.delete(key)
  if ((wrongBy.get(key)?.count ?? 0) >= MAX_WRONG_PER_ADDRESS) return { ok: false, status: 429 }

  // Control and format characters (zero-width, bidi overrides) are dropped; "This computer" is the machine's own name.
  const deviceName = typeof name === 'string' ? name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : ''
  if (deviceName === '' || deviceName.length > MAX_NAME || deviceName.toLowerCase() === THIS_COMPUTER.toLowerCase()) return { ok: false, status: 400 }

  if (current && now > current.expiresAt) current = null
  if (!current || typeof code !== 'string' || code !== current.code) {
    const w = wrongBy.get(key) ?? { count: 0, since: now }
    w.count++
    wrongBy.set(key, w)
    if (current && ++current.wrong >= MAX_WRONG_PER_CODE) current = null
    return { ok: false, status: 400 }
  }
  current = null

  const token = randomBytes(32).toString('base64url')
  db.insert(devices).values({ id: randomUUID(), name: deviceName, tokenHash: hashToken(token), createdAt: now, lastSeen: now }).run()
  return { ok: true, name: deviceName, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}` }
}

export interface DeviceRow { id: string, name: string, createdAt: number, lastSeen: number }

export function listDevices(db: Db = useDb()): DeviceRow[] {
  return db.select({ id: devices.id, name: devices.name, createdAt: devices.createdAt, lastSeen: devices.lastSeen })
    .from(devices).all().sort((a, b) => b.lastSeen - a.lastSeen)
}

const revoked = new Set<(id: string) => void>()

/** Called with a device's id when it is unpaired (live sockets close). */
export function onUnpair(fn: (id: string) => void): () => void {
  revoked.add(fn)
  return () => revoked.delete(fn)
}

/** Unpairs a device: its cookie is no longer trusted. False if there was no such device. */
export function unpair(db: Db, id: string): boolean {
  const r = db.delete(devices).where(eq(devices.id, id)).run()
  if (r.changes === 0) return false
  for (const fn of revoked) fn(id)
  return true
}
