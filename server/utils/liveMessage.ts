// One y-websocket message from a live peer, read and answered. The socket route calls it
// for each message in arrival order, so a peer's command runs after its earlier updates.
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { MESSAGE_COMMAND, type LiveAnswer } from '#shared/liveCommand'
import { MAX_BOARD_BYTES } from './boards'
import { VIEW_ONLY, type Received, type Room } from './rooms'

/** y-websocket message types; commands use MESSAGE_COMMAND from #shared/liveCommand. */
export const MESSAGE_SYNC = 0
export const MESSAGE_AWARENESS = 1

/**
 * The largest socket message a peer may send: a whole board's sync step 2 (a board is at most
 * MAX_BOARD_BYTES as JSON) with room to spare. The socket server refuses larger frames
 * itself (capSocketPayload); handleMessage checks again.
 */
export const MAX_MESSAGE_BYTES = 2 * MAX_BOARD_BYTES

/**
 * Cap the socket server's frames at MAX_MESSAGE_BYTES (ws defaults to 100 MiB), on Nitro's
 * h3 app before its socket server is made: Nitro hands `h3App.websocket` (which h3 builds,
 * once, from `options.websocket`) to crossws, and crossws passes `serverOptions` to ws.
 * A larger frame is never buffered: ws closes the socket with 1009.
 */
export function capSocketPayload(app: { options: { websocket?: object } }): void {
  const ws = (app.options.websocket ?? {}) as { serverOptions?: Record<string, unknown> }
  app.options.websocket = { ...ws, serverOptions: { ...ws.serverOptions, maxPayload: MAX_MESSAGE_BYTES } }
}

/** The parts of a socket peer the reader uses. */
export interface MessagePeer {
  readonly id: string
  send: (data: Uint8Array) => unknown
}

export function message(write: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder()
  write(e)
  return encoding.toUint8Array(e)
}

/** Sync step 1 is answered, step 2 and updates are validated, awareness is relayed, commands run. */
export function handleMessage(peer: MessagePeer, room: Room, author: string, data: Uint8Array): Received {
  if (data.byteLength > MAX_MESSAGE_BYTES) return { ok: false, reason: `the message is larger than ${MAX_MESSAGE_BYTES} bytes` }
  const d = decoding.createDecoder(data)
  const type = decoding.readVarUint(d)
  if (type === MESSAGE_AWARENESS) return room.receiveAwareness(peer.id, decoding.readVarUint8Array(d))
  if (type === MESSAGE_COMMAND) return command(peer, room, author, d)
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

const NOTHING = { undo: 'nothing to undo', redo: 'nothing to redo' } as const

/** Run an undo or redo command and answer it; a malformed command is rejected. */
function command(peer: MessagePeer, room: Room, author: string, d: decoding.Decoder): Received {
  // An empty type 3 is y-websocket's awareness query (sent only over BroadcastChannel): ignore it.
  if (!decoding.hasContent(d)) return { ok: true }
  // A viewer (or a peer the room let go) may not undo or redo: refused before the command is even read.
  const a = room.peerAccess(peer.id)
  if (!a || a.role === 'view') return VIEW_ONLY
  let parsed: unknown
  try {
    parsed = JSON.parse(decoding.readVarString(d))
  } catch {
    return { ok: false, reason: 'malformed command' }
  }
  const { op, id } = (parsed ?? {}) as { op?: unknown, id?: unknown }
  if ((op !== 'undo' && op !== 'redo') || typeof id !== 'number' || !Number.isFinite(id)) return { ok: false, reason: 'malformed command' }
  let reply: LiveAnswer
  try {
    const authorId = room.peerAuthorId(peer.id)
    const tokenId = room.peerTokenId(peer.id)
    const revision = op === 'undo' ? room.undo(author, authorId, tokenId) : room.redo(author, authorId, tokenId)
    reply = revision === null ? { id, ok: false, reason: NOTHING[op] } : { id, ok: true }
  } catch (e) {
    // A server fault, not the client's: answer it and keep the socket open.
    console.error(`[ws] ${op} failed`, e)
    reply = { id, ok: false, reason: `${op} failed on the server` }
  }
  peer.send(message((e) => {
    encoding.writeVarUint(e, MESSAGE_COMMAND)
    encoding.writeVarString(e, JSON.stringify(reply))
  }))
  return { ok: true }
}
