// The address of the machine on the other end of a request's socket.
//
// In production the request's socket is the client's own TCP connection, and its address
// is all that is read. Under `nuxt dev`, Nitro runs the server in a worker reached over a
// unix socket (or, in some setups, a loopback TCP port), through a proxy in the dev process;
// the worker's socket then has no address, or the proxy's 127.0.0.1. So in dev the socket
// is never read: the dev process (modules/peer-address.ts) stamps each request and upgrade
// with the address of *its* socket, signed with a per-run secret that only it and its
// worker know, replacing whatever the client sent under that name. Nothing a client can
// set (X-Forwarded-For, Host, this header without the secret) changes the result.
import { timingSafeEqual } from 'node:crypto'

/** The stamp the dev process adds: `<secret> <address> <port>`. */
export const PEER_HEADER = 'x-wirebender-peer'
/** The env var the dev process passes the secret to its worker in. */
export const PEER_SECRET_ENV = 'WIREBENDER_PEER_SECRET'

/** The parts of a Node request read here. */
export interface NodeReqLike {
  method?: string
  socket?: { remoteAddress?: string, localPort?: number } | null
  headers: Record<string, string | string[] | undefined>
}

export interface Remote {
  /** The client's address; undefined when it cannot be known (then nothing is trusted). */
  address: string | undefined
  /** The server port the client connected to. */
  port: number | undefined
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * In production (`allowStamp` false), the socket's address. In a dev build
 * (`import.meta.dev`), only the dev process's signed stamp: the worker's socket is the
 * proxy's, so with no valid stamp the address is unknown and nothing is trusted. A
 * production server never accepts a stamp, whatever its environment holds.
 */
export function remoteOf(req: NodeReqLike, secret: string | undefined = process.env[PEER_SECRET_ENV], allowStamp: boolean = import.meta.dev === true): Remote {
  const unknown = { address: undefined, port: undefined }
  if (!allowStamp) {
    const socket = req.socket
    return socket?.remoteAddress ? { address: socket.remoteAddress, port: socket.localPort } : unknown
  }
  const stamp = req.headers[PEER_HEADER]
  if (!secret || secret.length < 32 || typeof stamp !== 'string') return unknown
  const [given, address, port] = stamp.split(' ')
  if (!given || !address || !sameSecret(given, secret)) return unknown
  const n = Number(port)
  return { address, port: Number.isInteger(n) && n > 0 ? n : undefined }
}

/**
 * The secret to stamp with, given the dev listener's address: only a TCP listener owns
 * the clients' own sockets. On a unix socket (or not listening) it is null: stamp nothing.
 */
export function stampSecret(address: string | { address: string, family: string, port: number } | null, secret: string): string | null {
  return address !== null && typeof address === 'object' && address.port > 0 ? secret : null
}

/**
 * Dev process only: replace the client's stamp, if any, with this socket's address. With
 * no secret, or a socket with no address, there is no stamp at all (fail closed).
 */
export function stampPeer(req: NodeReqLike, secret: string | null): void {
  const s = req.socket
  if (secret && s?.remoteAddress) req.headers[PEER_HEADER] = `${secret} ${s.remoteAddress} ${s.localPort ?? ''}`
  else Reflect.deleteProperty(req.headers, PEER_HEADER)
}
