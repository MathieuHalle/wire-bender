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
import { PEER_SECRET_ENV, stampPeer } from '../server/utils/peerAddress'

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
      // First in line, before Nuxt's own handlers forward the request to the worker.
      s.prependListener('request', req => stampPeer(req, secret))
      s.prependListener('upgrade', req => stampPeer(req, secret))
    })
  }
})
