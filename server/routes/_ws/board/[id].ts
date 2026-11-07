import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { useDb } from '../../../db'
import { openRoom, type Received, type Room } from '../../../utils/rooms'

/** The parts of a crossws peer this handler uses. */
interface WsPeer {
  readonly id: string
  readonly request: { url: string }
  send: (data: Uint8Array) => unknown
  close: (code?: number, reason?: string) => void
}

/** y-websocket message types. */
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/** Close codes: a rejected or malformed message, and an unknown board. */
const CLOSE_REJECTED = 4400
const CLOSE_NO_BOARD = 4404

/** Who a peer's edits are recorded as. Task 7 replaces this with the access check. */
function authorFor(_peer: WsPeer): string {
  return 'Local'
}

/** The board id is the last path segment of `/_ws/board/<id>`. */
function boardId(peer: WsPeer): string {
  const path = new URL(peer.request.url, 'http://localhost').pathname
  return decodeURIComponent(path.split('/').filter(Boolean).at(-1) ?? '')
}

/** WebSocket close reasons are at most 123 bytes. */
function closeReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason)
  if (bytes.length <= 123) return reason
  return new TextDecoder().decode(bytes.slice(0, 120)).replace(/�$/, '') + '...'
}

function message(write: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder()
  write(e)
  return encoding.toUint8Array(e)
}

const joined = new Map<string, { room: Room, author: string }>()

function leave(peer: WsPeer): void {
  const live = joined.get(peer.id)
  if (!live) return
  joined.delete(peer.id)
  live.room.leave(peer.id)
}

/** One y-websocket message from a peer: sync step 1 is answered, step 2 and updates are validated, awareness is relayed. */
function handle(peer: WsPeer, room: Room, author: string, data: Uint8Array): Received {
  const d = decoding.createDecoder(data)
  const type = decoding.readVarUint(d)
  if (type === MESSAGE_AWARENESS) return room.receiveAwareness(peer.id, decoding.readVarUint8Array(d))
  if (type !== MESSAGE_SYNC) return { ok: true }
  const step = decoding.readVarUint(d)
  if (step === syncProtocol.messageYjsSyncStep1) {
    const stateVector = decoding.readVarUint8Array(d)
    peer.send(message((e) => {
      encoding.writeVarUint(e, MESSAGE_SYNC)
      syncProtocol.writeSyncStep2(e, room.doc, stateVector)
    }))
    return { ok: true }
  }
  if (step === syncProtocol.messageYjsSyncStep2 || step === syncProtocol.messageYjsUpdate) {
    return room.receive(peer.id, author, decoding.readVarUint8Array(d))
  }
  return { ok: false, reason: `unknown sync message ${step}` }
}

export default defineWebSocketHandler({
  open(peer) {
    const room = openRoom(useDb(), boardId(peer))
    if (!room) {
      peer.close(CLOSE_NO_BOARD, 'no such board')
      return
    }
    const author = authorFor(peer)
    joined.set(peer.id, { room, author })
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
  },

  message(peer, msg) {
    const live = joined.get(peer.id)
    if (!live) return
    let result: Received
    try {
      result = handle(peer, live.room, live.author, msg.uint8Array())
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
