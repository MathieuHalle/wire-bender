// The address of the machine on the other end of a request's socket.
//
// In production the request's socket is the client's own TCP connection, and its address
// is all that is read. Under `nuxt dev`, Nitro runs the server in a worker reached over a
// unix socket, through a proxy in the dev process; the worker's socket then has no
// address. So the dev process (modules/peer-address.ts) stamps each request and upgrade
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
 * The socket's address, or, on a socket with none (the dev worker), the dev process's
 * signed stamp. A stamp is only ever read in a dev build (`import.meta.dev`): a production
 * server never accepts one, whatever its environment holds.
 */
export function remoteOf(req: NodeReqLike, secret: string | undefined = process.env[PEER_SECRET_ENV], allowStamp: boolean = import.meta.dev === true): Remote {
  const socket = req.socket
  if (socket?.remoteAddress) return { address: socket.remoteAddress, port: socket.localPort }
  const stamp = req.headers[PEER_HEADER]
  if (!allowStamp || !secret || secret.length < 32 || typeof stamp !== 'string') return { address: undefined, port: undefined }
  const [given, address, port] = stamp.split(' ')
  if (!given || !address || !sameSecret(given, secret)) return { address: undefined, port: undefined }
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
