import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import type { BoardFile } from '~core/schema'
import { undoState } from '#shared/undoState'
import { boardToDoc, docToBoard, writeBoard } from '#shared/yboard'
import type { Db } from '../db'
import { boardBefore, commitRevision, getBoard, getRevision, listRevisions, recover, saveCurrent } from './boards'

/** Live updates from one author join one revision until that author has been idle this long. */
export const GROUP_IDLE_MS = 2000

/** How a room reaches one connected peer. */
export interface PeerLink {
  update: (update: Uint8Array) => void
  awareness: (update: Uint8Array) => void
}

export type Received = { ok: true } | { ok: false, reason: string }

export interface WriteMeta { author: string, how: string, target?: number }

const SERVER = 'server'
const rooms = new Map<string, Room>()

/** The live room for a board, opened (after `recover`) if none is open. `null` when there is no such board. */
export function openRoom(db: Db, id: string): Room | null {
  const open = rooms.get(id)
  if (open) return open
  recover(db, id)
  const stored = getBoard(db, id)
  if (!stored) return null
  const room = new Room(db, id, stored.board, stored.head)
  rooms.set(id, room)
  return room
}

/** One open board: its Yjs doc, the peers editing it, and each author's open revision group. */
export class Room {
  readonly doc = new Y.Doc()
  readonly awareness = new Awareness(this.doc)
  private board: BoardFile
  private head: number
  private readonly peers = new Map<string, { author: string, link: PeerLink, clients: Set<number> }>()
  private readonly groups = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(private readonly db: Db, readonly id: string, board: BoardFile, head: number) {
    this.board = board
    this.head = head
    boardToDoc(this.doc, board)
    this.writeServerMap()
    this.awareness.setLocalState(null)
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      for (const [peerId, peer] of this.peers) if (peerId !== origin) peer.link.update(update)
    })
    this.awareness.on('update', ({ added, updated, removed }: Record<'added' | 'updated' | 'removed', number[]>, origin: unknown) => {
      const from = typeof origin === 'string' ? this.peers.get(origin) : undefined
      if (from) {
        for (const c of added) from.clients.add(c)
        for (const c of removed) from.clients.delete(c)
      }
      const changed = [...added, ...updated, ...removed]
      const message = encodeAwarenessUpdate(this.awareness, changed)
      for (const [peerId, peer] of this.peers) if (peerId !== origin) peer.link.awareness(message)
    })
  }

  /** Add a peer. It is sent the presence of everyone already here; the doc itself comes through the sync protocol. */
  join(peerId: string, author: string, link: PeerLink): void {
    this.peers.set(peerId, { author, link, clients: new Set() })
    const present = [...this.awareness.getStates().keys()]
    if (present.length > 0) link.awareness(encodeAwarenessUpdate(this.awareness, present))
  }

  /** Validate a client's update on a copy of the doc; apply, broadcast and save it only if the board stays valid. */
  receive(peerId: string, author: string, update: Uint8Array): Received {
    const checked = this.check(update)
    if (!checked.ok) return checked
    let changed = false
    const mark = () => {
      changed = true
    }
    this.doc.on('update', mark)
    try {
      Y.applyUpdate(this.doc, update, peerId)
    } finally {
      this.doc.off('update', mark)
    }
    if (!changed) return { ok: true }
    this.board = checked.board
    saveCurrent(this.db, this.id, this.board)
    this.restartGroup(author)
    return { ok: true }
  }

  /** Apply a peer's presence and relay it to the others. */
  receiveAwareness(peerId: string, update: Uint8Array): Received {
    try {
      applyAwarenessUpdate(this.awareness, update, peerId)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: `malformed awareness update: ${(e as Error).message}` }
    }
  }

  /** Write a whole board as one revision (API, undo, redo), live to every peer. */
  serverWrite(next: BoardFile, meta: WriteMeta): number {
    this.closeGroups()
    writeBoard(this.doc, this.board, next, SERVER)
    const n = commitRevision(this.db, this.id, { board: next, author: meta.author, how: meta.how, target: meta.target })
    this.board = { ...next, revision: n }
    this.head = n
    this.writeServerMap()
    this.dropIfEmpty()
    return n
  }

  /** Revert the top of the board's undo stack. `null` when there is nothing to undo. */
  undo(author: string): number | null {
    this.closeGroups()
    const { undo } = this.stacks()
    if (undo === null) return this.nothing()
    return this.serverWrite(boardBefore(this.db, this.id, undo), { author, how: 'undo', target: undo })
  }

  /** Restore the top of the board's redo stack. `null` when there is nothing to redo. */
  redo(author: string): number | null {
    this.closeGroups()
    const { redo } = this.stacks()
    const rev = redo === null ? null : getRevision(this.db, this.id, redo)
    if (redo === null || !rev) return this.nothing()
    return this.serverWrite(rev.board, { author, how: 'redo', target: redo })
  }

  /** Remove a peer and its presence, and close its author's group. The last leave saves and drops the room. */
  leave(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      this.peers.delete(peerId)
      this.closeGroup(peer.author)
      if (peer.clients.size > 0) removeAwarenessStates(this.awareness, [...peer.clients], null)
    }
    this.dropIfEmpty()
  }

  private check(update: Uint8Array): { ok: true, board: BoardFile } | { ok: false, reason: string } {
    const copy = new Y.Doc()
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(this.doc))
      const server: object = copy.getMap(SERVER)
      let touchesServer = false
      copy.on('afterTransaction', (tr: Y.Transaction) => {
        if ([...tr.changed.keys()].some(t => t === server)) touchesServer = true
      })
      Y.applyUpdate(copy, update)
      if (touchesServer) return { ok: false, reason: 'the server map is written only by the server' }
      if (copy.store.pendingStructs || copy.store.pendingDs) return { ok: false, reason: 'the update depends on changes the server does not have' }
      const parsed = docToBoard(copy, this.head)
      if (!parsed.ok) return { ok: false, reason: parsed.errors.join('; ') }
      return { ok: true, board: parsed.board }
    } catch (e) {
      return { ok: false, reason: `malformed update: ${(e as Error).message}` }
    } finally {
      copy.destroy()
    }
  }

  private stacks() {
    return undoState(listRevisions(this.db, this.id).reverse())
  }

  private nothing(): null {
    this.dropIfEmpty()
    return null
  }

  private writeServerMap(): void {
    const { undo, redo } = this.stacks()
    const map = this.doc.getMap(SERVER)
    this.doc.transact(() => {
      map.set('revision', this.head)
      map.set('canUndo', undo !== null)
      map.set('canRedo', redo !== null)
    }, SERVER)
  }

  private restartGroup(author: string): void {
    clearTimeout(this.groups.get(author))
    this.groups.set(author, setTimeout(() => this.closeGroup(author), GROUP_IDLE_MS))
  }

  /** Commit an author's live edits as one `edit` revision. */
  private closeGroup(author: string): void {
    const timer = this.groups.get(author)
    if (timer === undefined) return
    clearTimeout(timer)
    this.groups.delete(author)
    this.head = commitRevision(this.db, this.id, { board: this.board, author, how: 'edit' })
    this.board = { ...this.board, revision: this.head }
    this.writeServerMap()
  }

  private closeGroups(): void {
    for (const author of [...this.groups.keys()]) this.closeGroup(author)
  }

  private dropIfEmpty(): void {
    if (this.peers.size > 0 || this.closed) return
    this.closeGroups()
    saveCurrent(this.db, this.id, this.board)
    this.closed = true
    if (rooms.get(this.id) === this) rooms.delete(this.id)
    this.awareness.destroy()
    this.doc.destroy()
  }
}
