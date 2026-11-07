import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { useDb } from '../../../db'
import { onUnpair, refusal, trust, type TrustSource } from '../../../utils/access'
import { access, recordVisit, type Access } from '../../../utils/boardAccess'
import { checkMode } from '../../../utils/mode'
import { authorIdOf, unlockedOf, whoIs, type Who } from '../../../utils/who'
import { MESSAGE_AWARENESS, MESSAGE_SYNC, handleMessage, message } from '../../../utils/liveMessage'
import { CLOSE_ACCESS, openRoom, type Received, type Room } from '../../../utils/rooms'
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

/**
 * Close codes: a rejected or malformed message, an untrusted peer, access changed (or a
 * viewer tried to edit: CLOSE_ACCESS, 4403), an unknown board, and a server error.
 */
const CLOSE_REJECTED = 4400
const CLOSE_UNTRUSTED = 4401
const CLOSE_NO_BOARD = 4404
const CLOSE_SERVER_ERROR = 1011

/** The author a viewer's presence goes under; a viewer never writes a revision. */
const VISITOR = 'Visitor'

type PeerWho = { ok: true, who: Who, deviceId?: string } | { ok: false }

/**
 * Who the peer is, on open. Local mode checks again: the upgrade was checked, but the
 * device may have been unpaired since. Public mode takes who the upgrade found (a session
 * can only be read there, asynchronously).
 */
function whoOf(peer: WsPeer): PeerWho {
  if (checkMode() === 'local') {
    const t = trust(peer.request)
    if (!t.ok) return { ok: false }
    const who: Who = t.device ? { kind: 'local', userId: 'local', author: t.author, device: t.device } : { kind: 'local', userId: 'local', author: t.author }
    return { ok: true, who, deviceId: t.device?.id }
  }
  const who = peer.context?.who as Who | undefined
  return who ? { ok: true, who } : { ok: false }
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

/** The board access of a socket's key, as the API decides it. */
function accessOf(url: string, who: Who, unlocked: readonly string[]): Access & { key?: string } {
  const key = wsBoardId(url)
  return key === null ? { ok: false, status: 404 } : { ...access(useDb(), who, key, unlocked), key }
}

/**
 * Join the peer to its board's room and start the sync. Access is decided again (the board's
 * sharing may have changed since the upgrade): a board it may no longer reach closes with
 * 4404, a password it has not entered with 4403 (the reconnect is asked for it).
 */
function join(peer: WsPeer): void {
  // Trust first: an untrusted peer learns nothing, not even whether the board exists.
  const w = whoOf(peer)
  if (!w.ok) {
    peer.close(CLOSE_UNTRUSTED, 'not paired')
    return
  }
  const unlocked = (peer.context?.unlocked as string[] | undefined) ?? []
  const a = accessOf(peer.request.url, w.who, unlocked)
  if (!a.ok) {
    if (a.status === 401) peer.close(CLOSE_ACCESS, 'password needed')
    else peer.close(CLOSE_NO_BOARD, 'no such board')
    return
  }
  const room = openRoom(useDb(), a.boardId)
  if (!room) {
    peer.close(CLOSE_NO_BOARD, 'no such board')
    return
  }
  const author = w.who.kind === 'anonymous' ? VISITOR : w.who.author
  joined.set(peer.id, { room, author, deviceId: w.deviceId, peer })
  room.join(peer.id, author, {
    update: u => peer.send(message((e) => {
      encoding.writeVarUint(e, MESSAGE_SYNC)
      syncProtocol.writeUpdate(e, u)
    })),
    awareness: u => peer.send(message((e) => {
      encoding.writeVarUint(e, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(e, u)
    }))
  }, { role: a.role, viaLink: a.viaLink, authorId: authorIdOf(w.who) })
  recordVisit(useDb(), w.who, a, a.key!)
  peer.send(message((e) => {
    encoding.writeVarUint(e, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(e, room.doc)
  }))
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export default defineWebSocketHandler({
  // The access middleware does not see upgrades: the same checks run here. A socket from
  // another site (rebinding Host, foreign Origin) is refused; in local mode only the machine
  // itself and paired devices may connect. Then the board's access decides, as in the API:
  // the same 404 as an unknown board, or 401 `{ password: true }`.
  async upgrade(request) {
    const source = request as TrustSource
    if (refusal(source)) return new Response('This request names another site.', { status: 403 })
    const who = await whoIs(source)
    if (checkMode() === 'local' && who.kind === 'anonymous') return new Response('This device is not paired.', { status: 401 })
    const unlocked = await unlockedOf(source)
    const a = accessOf((request as { url: string }).url, who, unlocked)
    if (!a.ok) return a.status === 401 ? json(401, { password: true }) : json(404, { error: 'not found' })
    // crossws hands this context to the peer on open.
    const context = (request as { context?: Record<string, unknown> }).context
    if (context) {
      context.who = who
      context.unlocked = unlocked
    }
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
      peer.close(result.code ?? CLOSE_REJECTED, closeReason(result.reason))
    }
  },

  close(peer) {
    leave(peer)
  },

  error(peer) {
    leave(peer)
  }
})
