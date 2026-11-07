// Dev only: tell the Nitro dev worker who is on the other end of each socket.
//
// `nuxt dev` serves the app from a worker behind a proxy, over a unix socket, so the worker
// cannot see the client's address. This module stamps every request and WebSocket upgrade
// that reaches the dev listener with the listener socket's address, signed with a secret
// made here and passed to the worker in its environment (server/utils/peerAddress.ts).
// A stamp sent by the client is always overwritten. Production reads the socket directly.
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { defineNuxtModule } from 'nuxt/kit'
import { checkMode } from '../server/utils/access'
import { PEER_SECRET_ENV, stampPeer, stampSecret } from '../server/utils/peerAddress'

const STAMPED = Symbol.for('wirebender.peer-stamped')
const SECRET = Symbol.for('wirebender.peer-secret')
const store = globalThis as { [SECRET]?: string }

export default defineNuxtModule({
  meta: { name: 'wirebender-peer-address' },
  setup(_options, nuxt) {
    if (!nuxt.options.dev) return
    // A wrong mode stops `nuxt dev` here, at start (server/plugins/startup.ts checks it again in the server).
    checkMode(process.env)
    // One secret per dev process (a Nuxt restart keeps it, as the listener is kept), set
    // before Nitro starts its worker, which copies this process's environment.
    const secret = store[SECRET] ??= randomBytes(32).toString('hex')
    process.env[PEER_SECRET_ENV] = secret
    nuxt.hook('listen', (server: Server) => {
      const s = server as Server & { [STAMPED]?: boolean }
      if (s[STAMPED]) return
      s[STAMPED] = true
      const once = new Set<string>()
      const warn = (m: string) => once.has(m) || (once.add(m), console.warn(`[wirebender] ${m}`))
      const NOT_TCP = 'the dev listener is not on TCP: client addresses are unknown, so no request is trusted (not even this computer).'
      if (!stampSecret(s.address(), secret)) warn(NOT_TCP)
      /**
       * The stamp is only as good as this listener owning the clients' own TCP sockets.
       * Checked per request: on a unix socket, or a connection with no address, nothing is
       * stamped and a client's stamp is still dropped, so nothing is trusted.
       */
      const stamp = (req: Parameters<typeof stampPeer>[0]) => {
        const use = stampSecret(s.address(), secret)
        if (!use) warn(NOT_TCP)
        else if (!req.socket?.remoteAddress) warn('a dev connection has no client address: it is not trusted.')
        stampPeer(req, use)
      }
      // First in line, before Nuxt's own handlers forward the request to the worker.
      s.prependListener('request', stamp)
      s.prependListener('upgrade', stamp)
    })
  }
})
