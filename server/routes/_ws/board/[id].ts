import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { useDb } from '../../../db'
import { openRoom, type Received, type Room } from '../../../utils/rooms'
import { wsBoardId } from '../../../utils/wsBoardId'

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

/** Close codes: a rejected or malformed message, an unknown or malformed board id, and a server error. */
const CLOSE_REJECTED = 4400
const CLOSE_NO_BOARD = 4404
const CLOSE_SERVER_ERROR = 1011

/** Who a peer's edits are recorded as. Task 7 replaces this with the access check. */
function authorFor(_peer: WsPeer): string {
  return 'Local'
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
  try {
    live.room.leave(peer.id)
  } catch (e) {
    console.error('[ws] could not close a peer\'s edits', e)
  }
}

/** Join the peer to its board's room and start the sync; an unknown or malformed id closes it with 4404. */
function join(peer: WsPeer): void {
  const id = wsBoardId(peer.request.url)
  const room = id === null ? null : openRoom(useDb(), id)
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
