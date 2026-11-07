import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { parseBoard, type BoardFile } from '~core/schema'
import { undoState } from '#shared/undoState'
import { RECORDS, SECTION_NAMES, boardToDoc, docToBoard, itemKey, sameItems, unknownSingles, withItems, writeBoard } from '#shared/yboard'
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
/** The top-level types a client may change. */
const CLIENT_TYPES = new Set<string>([...SECTION_NAMES, ...RECORDS, 'singles'])

/** Call one peer's link; a failing peer must not affect the room or the others. */
function safely(send: () => void): void {
  try {
    send()
  } catch {
    // The socket's own close handler removes the peer.
  }
}

/** The name of the top-level type that holds `type`, and the key under it (null for the type itself). */
function rootOf(doc: Y.Doc, type: Y.AbstractType<unknown>, sub: string | null): { name: string, key: string | null } {
  let t = type
  let key = sub
  while (t._item) {
    key = t._item.parentSub
    t = t._item.parent as Y.AbstractType<unknown>
  }
  for (const [name, shared] of doc.share) if (shared === t) return { name, key }
  return { name: '?', key }
}

const SECTION_SET = new Set<string>(SECTION_NAMES)
const mapItems = (map: Y.Map<unknown>) => (map as unknown as { _map: Map<string, Y.Item> })._map
const sameId = (a: Y.ID | null, b: Y.ID) => a !== null && a.client === b.client && a.clock === b.clock

/**
 * The first key the update creates over a live value it never saw (two people drew the same
 * id at once), or null. A Y.Map set links its item to the item it replaced, as the writer
 * saw it: an edit of a value the writer saw links to that item and deletes it in the same
 * update; a create links to nothing, or to a deleted item, and deletes nothing. Editing a
 * value someone else changed meanwhile stays "later wins" (spec §6).
 */
function createCollision(server: Y.Doc, copy: Y.Doc, before: Map<number, number>, update: Uint8Array, keys: Iterable<string>): string | null {
  const isNew = (id: Y.ID) => id.clock >= (before.get(id.client) ?? 0)
  let deletes: ReturnType<typeof Y.decodeUpdate>['ds'] | null = null
  for (const k of keys) {
    const at = k.indexOf(':')
    const name = k.slice(0, at)
    if (!SECTION_SET.has(name)) continue
    const key = k.slice(at + 1)
    const live = mapItems(server.getMap(name)).get(key)
    if (!live || live.deleted) continue
    // The update's items for the key: the winner, or ones that lost to a concurrent write
    // (those stay in the key's chain, deleted). Each first write links to what it replaced.
    for (let item = mapItems(copy.getMap(name)).get(key) ?? null; item; item = item.left as Y.Item | null) {
      if (!isNew(item.id) || (item.origin && isNew(item.origin))) continue
      const origin = item.origin
      if (origin && sameId(origin, live.id)) continue
      deletes ??= Y.decodeUpdate(update).ds
      if (origin && Y.isDeleted(deletes, origin)) continue
      return key
    }
  }
  return null
}

/** One author's open revision group: its idle timer and the items its accepted updates touched. */
interface Group { timer: ReturnType<typeof setTimeout>, keys: Set<string> }
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
  private readonly groups = new Map<string, Group>()
  private closed = false

  constructor(private readonly db: Db, readonly id: string, board: BoardFile, head: number) {
    this.board = board
    this.head = head
    boardToDoc(this.doc, board)
    this.writeServerMap()
    this.awareness.setLocalState(null)
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      for (const [peerId, peer] of this.peers) if (peerId !== origin) safely(() => peer.link.update(update))
    })
    this.awareness.on('update', ({ added, updated, removed }: Record<'added' | 'updated' | 'removed', number[]>, origin: unknown) => {
      const from = typeof origin === 'string' ? this.peers.get(origin) : undefined
      if (from) {
        for (const c of added) from.clients.add(c)
        for (const c of removed) from.clients.delete(c)
      }
      const changed = [...added, ...updated, ...removed]
      const message = encodeAwarenessUpdate(this.awareness, changed)
      for (const [peerId, peer] of this.peers) if (peerId !== origin) safely(() => peer.link.awareness(message))
    })
  }

  /** Add a peer. It is sent the presence of everyone already here; the doc itself comes through the sync protocol. */
  join(peerId: string, author: string, link: PeerLink): void {
    this.peers.set(peerId, { author, link, clients: new Set() })
    const present = [...this.awareness.getStates().keys()]
    if (present.length > 0) safely(() => link.awareness(encodeAwarenessUpdate(this.awareness, present)))
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
    this.restartGroup(author, checked.keys)
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

  /** Commit every open live group, so the head revision holds all accepted edits. Returns the head. */
  flush(): number {
    this.closeGroups()
    return this.head
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

  private check(update: Uint8Array): { ok: true, board: BoardFile, keys: Set<string> } | { ok: false, reason: string } {
    const copy = new Y.Doc()
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(this.doc))
      const before = Y.decodeStateVector(Y.encodeStateVector(copy))
      const touched = new Set<string>()
      const keys = new Set<string>()
      copy.on('afterTransaction', (tr: Y.Transaction) => {
        for (const [t, subs] of tr.changed) {
          for (const sub of subs.size > 0 ? subs : [null]) {
            const { name, key } = rootOf(copy, t as Y.AbstractType<unknown>, sub)
            touched.add(name)
            if (key !== null) keys.add(itemKey(name, key))
          }
        }
      })
      Y.applyUpdate(copy, update)
      if (touched.has(SERVER)) return { ok: false, reason: 'the server map is written only by the server' }
      const foreign = [...touched].filter(name => !CLIENT_TYPES.has(name))
      if (foreign.length > 0) return { ok: false, reason: `the update writes ${foreign.map(n => `"${n}"`).join(', ')}, which is not part of a board` }
      if (copy.store.pendingStructs || copy.store.pendingDs) return { ok: false, reason: 'the update depends on changes the server does not have' }
      const extra = unknownSingles(copy)
      if (extra.length > 0) return { ok: false, reason: `the update writes ${extra.map(n => `singles."${n}"`).join(', ')}, which is not part of a board` }
      const collision = createCollision(this.doc, copy, before, update, keys)
      if (collision !== null) return { ok: false, reason: `${collision} was just created by someone else; draw it again` }
      const parsed = docToBoard(copy, this.head)
      if (!parsed.ok) return { ok: false, reason: parsed.errors.join('; ') }
      return { ok: true, board: parsed.board, keys }
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

  private restartGroup(author: string, keys: Set<string>): void {
    const group = this.groups.get(author)
    clearTimeout(group?.timer)
    const timer = setTimeout(() => this.closeGroup(author), GROUP_IDLE_MS)
    if (group) {
      group.timer = timer
      for (const k of keys) group.keys.add(k)
    } else {
      this.groups.set(author, { timer, keys: new Set(keys) })
    }
  }

  /**
   * Commit an author's live edits as one `edit` revision: the head board with the items that
   * author touched set to their current values, so another author's open edits stay out.
   * Nothing is committed when that board is the head's. If it does not parse (the author's
   * edits need someone else's), every open group is committed together, as the current board.
   */
  private closeGroup(author: string): void {
    const group = this.groups.get(author)
    if (!group) return
    clearTimeout(group.timer)
    this.groups.delete(author)
    const head = getRevision(this.db, this.id, this.head)
    if (!head) return this.commitEdit(this.board, author)
    const composed = parseBoard(withItems(head.board, this.board, group.keys))
    if (composed.ok) {
      if (sameItems(head.board, composed.board)) return
      return this.commitEdit(composed.board, author)
    }
    const authors = [author]
    for (const [other, g] of this.groups) {
      clearTimeout(g.timer)
      authors.push(other)
    }
    this.groups.clear()
    if (sameItems(head.board, this.board)) return
    this.commitEdit(this.board, authors.join(', '))
  }

  private commitEdit(board: BoardFile, author: string): void {
    this.head = commitRevision(this.db, this.id, { board, author, how: 'edit' })
    this.board = { ...this.board, revision: this.head }
    // The commit stored `board` as current; the live board may hold other authors' open edits.
    if (!sameItems(board, this.board)) saveCurrent(this.db, this.id, this.board)
    this.writeServerMap()
  }

  private closeGroups(): void {
    for (const author of [...this.groups.keys()]) this.closeGroup(author)
  }

  /** With no peers left: save, close the open groups and drop the room. */
  dropIfEmpty(): void {
    if (this.peers.size > 0 || this.closed) return
    this.closeGroups()
    saveCurrent(this.db, this.id, this.board)
    this.closed = true
    if (rooms.get(this.id) === this) rooms.delete(this.id)
    this.awareness.destroy()
    this.doc.destroy()
  }
}
