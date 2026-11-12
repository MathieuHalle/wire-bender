// The visitor's address for the per-address limits (setup codes, password-link unlocks,
// bundle downloads), in public mode behind a reverse proxy such as Caddy. There every
// request comes from the proxy, so all signed-out visitors would share one limit.
//
// WIREBENDER_TRUST_PROXY lists the proxies (addresses or ranges, comma-separated). A request
// whose socket is one of them is read through X-Forwarded-For: the proxy appends the address
// it saw, so the last entry that is not itself a trusted proxy is the visitor (anything to
// its left was sent by the visitor and proves nothing). Any other request, an unset list, and
// local mode all use the socket alone. This never decides trust: "this computer" (local mode)
// is always the socket's own address (access.ts).
import { BlockList, isIP } from 'node:net'
import { remoteOf, type NodeReqLike } from './peerAddress'

type Env = Record<string, string | undefined>

export const TRUST_PROXY_ERROR = 'WIREBENDER_TRUST_PROXY must list addresses or ranges (such as 172.30.0.0/24), comma-separated; this one is not:'

export interface TrustedProxies {
  check(address: string): boolean
}

/** The trusted proxies, or null when none are set; throws (the server stops) on a wrong entry. */
export function parseTrustProxy(raw: string | undefined): TrustedProxies | null {
  const entries = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (entries.length === 0) return null
  const list = new BlockList()
  for (const entry of entries) {
    const [address = '', prefix, extra] = entry.split('/')
    const family = isIP(address)
    const bits = prefix === undefined ? null : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN
    const max = family === 6 ? 128 : 32
    if (family === 0 || extra !== undefined || (bits !== null && !(bits >= 0 && bits <= max))) throw new Error(`${TRUST_PROXY_ERROR} ${entry}`)
    const type = family === 6 ? 'ipv6' : 'ipv4'
    if (bits === null) list.addAddress(address, type)
    else list.addSubnet(address, bits, type)
  }
  return {
    check(address: string): boolean {
      const family = isIP(address)
      return family !== 0 && list.check(address, family === 6 ? 'ipv6' : 'ipv4')
    }
  }
}

let cached: { raw: string | undefined, value: TrustedProxies | null } | null = null
function trusted(env: Env): TrustedProxies | null {
  const raw = env.WIREBENDER_TRUST_PROXY
  if (cached === null || cached.raw !== raw) cached = { raw, value: parseTrustProxy(raw) }
  return cached.value
}

/** The request's visitor address, for rate limits only; undefined when it can't be known. */
export function clientAddress(req: NodeReqLike, env: Env = process.env): string | undefined {
  const peer = remoteOf(req).address
  if (peer === undefined || env.WIREBENDER_MODE !== 'public') return peer
  const proxies = trusted(env)
  if (!proxies?.check(peer)) return peer
  const header = req.headers['x-forwarded-for']
  const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(s => s.trim()).filter(s => isIP(s) !== 0)
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!proxies.check(hops[i]!)) return hops[i]
  }
  // Every hop is a proxy (or none was given): the leftmost one we were told of, else the socket.
  return hops[0] ?? peer
}
