import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { useDb } from '../../../db'
import { onUnpair, refusal, trust, type TrustSource } from '../../../utils/access'
import { checkMode } from '../../../utils/mode'
import { whoIs, type Who } from '../../../utils/who'
import { MESSAGE_AWARENESS, MESSAGE_SYNC, handleMessage, message } from '../../../utils/liveMessage'
import { openRoom, type Received, type Room } from '../../../utils/rooms'
import { wsBoardId } from '../../../utils/wsBoardId'

/** The parts of a crossws peer this handler uses. */
interface WsPeer {
  readonly id: string
  readonly request: { url: string } & TrustSource
  /** crossws: what the upgrade hook put in its request's context. */
  readonly context?: Record<string, unknown>
  send: (data: Uint8Array) => unknown
  close: (code?: number, reason?: string) => void
}

/** Close codes: a rejected or malformed message, an untrusted peer, an unknown or malformed board id, and a server error. */
const CLOSE_REJECTED = 4400
const CLOSE_UNTRUSTED = 4401
const CLOSE_NO_BOARD = 4404
const CLOSE_SERVER_ERROR = 1011

type PeerAccess = { ok: true, author: string, deviceId?: string } | { ok: false }

/**
 * The access check on open. Local mode runs it again: the upgrade was checked, but the
 * device may have been unpaired since. Public mode takes who the upgrade found (a session
 * can only be read there, asynchronously; Task 4 checks the board's access on open too).
 */
function accessOf(peer: WsPeer): PeerAccess {
  if (checkMode() === 'local') {
    const t = trust(peer.request)
    return t.ok ? { ok: true, author: t.author, deviceId: t.device?.id } : { ok: false }
  }
  const who = peer.context?.who as Who | undefined
  return who?.kind === 'user' ? { ok: true, author: who.author } : { ok: false }
}

/** WebSocket close reasons are at most 123 bytes. */
function closeReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason)
  if (bytes.length <= 123) return reason
  return new TextDecoder().decode(bytes.slice(0, 120)).replace(/�$/, '') + '...'
}

const joined = new Map<string, { room: Room, author: string, deviceId?: string, peer: WsPeer }>()

// An unpaired device's live sockets close at once.
onUnpair((deviceId) => {
  for (const live of [...joined.values()]) {
    if (live.deviceId !== deviceId) continue
    leave(live.peer)
    live.peer.close(CLOSE_UNTRUSTED, 'device unpaired')
  }
})

function leave(peer: WsPeer): void {
  const live = joined.get(peer.id)
  if (!live) return
  joined.delete(peer.id)
  try {
    live.room.leave(peer.id)
  } catch (e) {
    console.error('[ws] could not close a peer\'s edits', e)
  }
}

/** Join the peer to its board's room and start the sync; an unknown or malformed id closes it with 4404. */
function join(peer: WsPeer): void {
  // Trust first: an untrusted peer learns nothing, not even whether the board exists.
  const t = accessOf(peer)
  if (!t.ok) {
    peer.close(CLOSE_UNTRUSTED, 'not paired')
    return
  }
  const id = wsBoardId(peer.request.url)
  const room = id === null ? null : openRoom(useDb(), id)
  if (!room) {
    peer.close(CLOSE_NO_BOARD, 'no such board')
    return
  }
  const author = t.author
  joined.set(peer.id, { room, author, deviceId: t.deviceId, peer })
  room.join(peer.id, author, {
    update: u => peer.send(message((e) => {
      encoding.writeVarUint(e, MESSAGE_SYNC)
      syncProtocol.writeUpdate(e, u)
    })),
    awareness: u => peer.send(message((e) => {
      encoding.writeVarUint(e, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(e, u)
    }))
  })
  peer.send(message((e) => {
    encoding.writeVarUint(e, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(e, room.doc)
  }))
}

export default defineWebSocketHandler({
  // The access middleware does not see upgrades: the same checks run here. A socket from
  // another site (rebinding Host, foreign Origin) is refused, then only the machine itself
  // and paired devices (local mode) or a signed-in user (public mode) may connect.
  async upgrade(request) {
    const source = request as TrustSource
    if (refusal(source)) return new Response('This request names another site.', { status: 403 })
    const local = checkMode() === 'local'
    const who = await whoIs(source)
    if (who.kind === 'anonymous') return new Response(local ? 'This device is not paired.' : 'Sign in first.', { status: 401 })
    // crossws hands this context to the peer on open.
    const context = (request as { context?: Record<string, unknown> }).context
    if (context) context.who = who
  },

  open(peer) {
    try {
      join(peer)
    } catch (e) {
      console.error('[ws] could not open a board', e)
      leave(peer)
      peer.close(CLOSE_SERVER_ERROR, 'server error')
    }
  },

  message(peer, msg) {
    const live = joined.get(peer.id)
    if (!live) return
    let result: Received
    try {
      result = handleMessage(peer, live.room, live.author, msg.uint8Array())
    } catch (e) {
      result = { ok: false, reason: `malformed message: ${(e as Error).message}` }
    }
    if (!result.ok) {
      leave(peer)
      peer.close(CLOSE_REJECTED, closeReason(result.reason))
    }
  },

  close(peer) {
    leave(peer)
  },

  error(peer) {
    leave(peer)
  }
})
