import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { parseBoard, type BoardFile } from '~core/schema'
import { undoState } from '#shared/undoState'
import { RECORDS, SECTION_NAMES, boardToDoc, docToBoard, itemKey, sameItems, unknownSingles, withItems, writeBoard } from '#shared/yboard'
import type { Db } from '../db'
import type { Role } from './boardAccess'
import { MAX_BOARD_BYTES, boardBefore, commitRevision, getBoard, getRevision, listRevisions, recover, saveCurrent } from './boards'

/** Live updates from one author join one revision until that author has been idle this long. */
export const GROUP_IDLE_MS = 2000

/** The largest presence update a peer may send: a name, an avatar URL and a colour fit many times. */
export const MAX_AWARENESS_BYTES = 8192

/** How a room reaches one connected peer. */
export interface PeerLink {
  update: (update: Uint8Array) => void
  awareness: (update: Uint8Array) => void
  /** Close the peer's connection; the room has already let it go (kickLinkPeers). */
  close?: (code: number, reason: string) => void
}

/** A refusal with `code` closes the socket with that code (else 4400). */
export type Received = { ok: true } | { ok: false, reason: string, code?: number }

/** How a peer reached the board: its role, and whether by the share link (Task 5 closes those on a sharing change). */
export interface PeerAccess { role: Role, viaLink: boolean }

/** Who a peer is in presence, set by the server: its account's name and avatar, or `Guest`. */
export interface Presence { name: string, avatar?: string }

/**
 * How a peer joins: its access, the account its edits are by, and its presence. Without
 * `presence` (local mode) the peer names itself (`Local · <device>`).
 */
export interface JoinOptions extends PeerAccess { authorId?: string | null, presence?: Presence }

/** Access changed, or never allowed this: a view peer tried to edit. */
export const CLOSE_ACCESS = 4403
export const VIEW_ONLY: Received = { ok: false, reason: 'view only', code: CLOSE_ACCESS }
const NOT_JOINED: Received = { ok: false, reason: 'not in this room', code: CLOSE_ACCESS }
/** An edit-link peer's update that changes the board's name (spec §5: only the owner renames). */
export const OWNER_RENAMES = 'Only the owner can rename the board.'

/** `authorId`: the account the revision is by ('local' for the local user), null for none. */
export interface WriteMeta { author: string, how: string, target?: number, authorId?: string | null }

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
// createCollision reads Yjs internals (`_map`, `item.left`, `item.origin`), checked against
// yjs 13.6.33. The collision tests in tests/server/rooms.test.ts guard them on an upgrade.
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
    // Known limitation: for a sync step 2 the update's delete set is the client's whole
    // delete set, so a create whose origin is an old tombstone passes as an edit. Every
    // reconnect starts a fresh, read-only-until-synced doc, so a step 2 carries no creates.
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

/**
 * One author's open revision group: who (account and display name), its idle timer and the
 * items its accepted updates touched. Groups are keyed by both (groupKey): anyone may take
 * any display name, so two accounts' edits never share a group.
 */
interface Group { author: string, authorId: string | null, timer: ReturnType<typeof setTimeout>, keys: Set<string> }

const groupKey = (author: string, authorId: string | null): string => JSON.stringify([authorId, author])
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

/**
 * The board's sharing changed: every peer that came by the share link leaves the open room
 * at once and is closed with CLOSE_ACCESS, so it reconnects and its access is decided anew.
 * Peers by board id (the owner) stay. Nothing to do when the room is not open.
 */
export function kickLinkPeers(boardId: string): void {
  rooms.get(boardId)?.kickLinkPeers()
}

/** The board went to or came back from the trash: every peer but the owner (by board id) is closed with CLOSE_ACCESS. */
export function kickNonOwnerPeers(boardId: string): void {
  rooms.get(boardId)?.kickPeers(access => access.role !== 'owner')
}

/**
 * An account was deleted: in every open room, its own peers are closed with CLOSE_ACCESS,
 * and in its boards' rooms every peer is (the owner is signed out, the links are 404).
 */
export function kickAccount(userId: string, boardIds: ReadonlySet<string>): void {
  for (const room of [...rooms.values()]) {
    room.kickPeers((_, authorId) => boardIds.has(room.id) || authorId === userId)
  }
}

/** Close code for a board that no longer exists. */
export const CLOSE_NO_BOARD = 4404

/**
 * The board is deleted for good (or purged): its room closes every peer with CLOSE_NO_BOARD
 * and is dropped without saving or committing anything. Call before the rows are deleted.
 */
export function closeRoom(boardId: string): void {
  rooms.get(boardId)?.discard()
}

/** One open board: its Yjs doc, the peers editing it, and each author's open revision group. */
export class Room {
  readonly doc = new Y.Doc()
  readonly awareness = new Awareness(this.doc)
  private board: BoardFile
  private head: number
  private readonly peers = new Map<string, { author: string, authorId: string | null, link: PeerLink, clients: Set<number>, access: PeerAccess, presence?: Presence }>()
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
        // Updated too: a peer that writes another client's state owns it from then on, so it
        // goes when that peer leaves.
        for (const c of [...added, ...updated]) from.clients.add(c)
        for (const c of removed) from.clients.delete(c)
        // A stamped peer's name and avatar are the server's, whatever it sent and under
        // whichever client id (a forged one shows the sender's own name).
        if (from.presence) for (const c of [...added, ...updated]) this.stamp(c, from.presence)
      }
      const changed = [...added, ...updated, ...removed]
      const message = encodeAwarenessUpdate(this.awareness, changed)
      for (const [peerId, peer] of this.peers) if (peerId !== origin) safely(() => peer.link.awareness(message))
    })
  }

  /** Overwrite the name and avatar in client `c`'s presence with `presence`. */
  private stamp(c: number, presence: Presence): void {
    const state = this.awareness.states.get(c)
    if (!state) return
    const sent = state.user
    const { avatar: _avatar, ...rest } = typeof sent === 'object' && sent !== null ? sent as Record<string, unknown> : {}
    const user = presence.avatar ? { ...rest, name: presence.name, avatar: presence.avatar } : { ...rest, name: presence.name }
    this.awareness.states.set(c, { ...state, user })
  }

  /**
   * Add a peer. It is sent the presence of everyone already here; the doc itself comes
   * through the sync protocol. A peer joined without `access` is the owner by board id.
   */
  join(peerId: string, author: string, link: PeerLink, options: JoinOptions = { role: 'owner', viaLink: false }): void {
    const { authorId = null, role, viaLink, presence } = options
    this.peers.set(peerId, { author, authorId, link, clients: new Set(), access: { role, viaLink }, presence })
    const present = [...this.awareness.getStates().keys()]
    if (present.length > 0) safely(() => link.awareness(encodeAwarenessUpdate(this.awareness, present)))
  }

  /** A joined peer's role and how it came, or null. */
  peerAccess(peerId: string): PeerAccess | null {
    const peer = this.peers.get(peerId)
    return peer ? { ...peer.access } : null
  }

  /** The account a joined peer's edits are by, or null. */
  peerAuthorId(peerId: string): string | null {
    return this.peers.get(peerId)?.authorId ?? null
  }

  /**
   * Validate a client's update on a copy of the doc; apply, broadcast and save it only if the
   * board stays valid. A view peer's update is refused unless it changes nothing (its sync
   * step 2 on connecting); anyone but the owner's is refused if it renames the board.
   */
  receive(peerId: string, author: string, update: Uint8Array): Received {
    const peer = this.peers.get(peerId)
    if (!peer) return NOT_JOINED
    if (peer.access.role === 'view') return this.changes(update) ? VIEW_ONLY : { ok: true }
    const checked = this.check(update, peer.access.role)
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
    this.restartGroup(author, this.peerAuthorId(peerId), checked.keys)
    return { ok: true }
  }

  /** Apply a peer's presence and relay it to the others. */
  receiveAwareness(peerId: string, update: Uint8Array): Received {
    if (!this.peers.has(peerId)) return NOT_JOINED
    if (update.byteLength > MAX_AWARENESS_BYTES) return { ok: false, reason: `the presence update is larger than ${MAX_AWARENESS_BYTES} bytes` }
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
    const n = commitRevision(this.db, this.id, { board: next, author: meta.author, how: meta.how, target: meta.target, authorId: meta.authorId })
    this.board = { ...next, revision: n }
    this.head = n
    this.writeServerMap()
    this.dropIfEmpty()
    return n
  }

  /** Revert the top of the board's undo stack. `null` when there is nothing to undo. */
  undo(author: string, authorId: string | null = null): number | null {
    this.closeGroups()
    const { undo } = this.stacks()
    if (undo === null) return this.nothing()
    return this.serverWrite(boardBefore(this.db, this.id, undo), { author, how: 'undo', target: undo, authorId })
  }

  /** Restore the top of the board's redo stack. `null` when there is nothing to redo. */
  redo(author: string, authorId: string | null = null): number | null {
    this.closeGroups()
    const { redo } = this.stacks()
    const rev = redo === null ? null : getRevision(this.db, this.id, redo)
    if (redo === null || !rev) return this.nothing()
    return this.serverWrite(rev.board, { author, how: 'redo', target: redo, authorId })
  }

  /** Remove a peer and its presence, and close its author's group. The last leave saves and drops the room. */
  leave(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      this.peers.delete(peerId)
      this.closeGroup(groupKey(peer.author, peer.authorId))
      if (peer.clients.size > 0) removeAwarenessStates(this.awareness, [...peer.clients], null)
    }
    this.dropIfEmpty()
  }

  /** See the module-level kickLinkPeers. */
  kickLinkPeers(): void {
    this.kickPeers(access => access.viaLink)
  }

  /** Every peer `which` picks leaves at once and is closed with CLOSE_ACCESS. */
  kickPeers(which: (access: PeerAccess, authorId: string | null) => boolean): void {
    for (const [peerId, peer] of [...this.peers]) {
      if (!which(peer.access, peer.authorId)) continue
      this.leave(peerId)
      safely(() => peer.link.close?.(CLOSE_ACCESS, 'access changed'))
    }
  }

  /** See the module-level closeRoom. */
  discard(): void {
    if (this.closed) return
    const peers = [...this.peers.values()]
    this.peers.clear()
    for (const g of this.groups.values()) clearTimeout(g.timer)
    this.groups.clear()
    this.closed = true
    if (rooms.get(this.id) === this) rooms.delete(this.id)
    for (const peer of peers) safely(() => peer.link.close?.(CLOSE_NO_BOARD, 'no such board'))
    this.awareness.destroy()
    this.doc.destroy()
  }

  /** True when applying `update` would change the doc. */
  private changes(update: Uint8Array): boolean {
    const copy = new Y.Doc()
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(this.doc))
      let changed = false
      copy.on('update', () => {
        changed = true
      })
      Y.applyUpdate(copy, update)
      return changed || copy.store.pendingStructs !== null || copy.store.pendingDs !== null
    } catch {
      return true
    } finally {
      copy.destroy()
    }
  }

  private check(update: Uint8Array, role: Role): { ok: true, board: BoardFile, keys: Set<string> } | { ok: false, reason: string } {
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
      // The API's cap: live edits may not grow a board past what a PUT may send.
      if (Buffer.byteLength(JSON.stringify(parsed.board)) > MAX_BOARD_BYTES) return { ok: false, reason: `the board would be larger than ${MAX_BOARD_BYTES} bytes` }
      if (role !== 'owner' && parsed.board.name !== this.board.name) return { ok: false, reason: OWNER_RENAMES }
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

  private restartGroup(author: string, authorId: string | null, keys: Set<string>): void {
    const key = groupKey(author, authorId)
    const group = this.groups.get(key)
    clearTimeout(group?.timer)
    const timer = setTimeout(() => this.closeGroup(key), GROUP_IDLE_MS)
    if (group) {
      group.timer = timer
      for (const k of keys) group.keys.add(k)
    } else {
      this.groups.set(key, { author, authorId, timer, keys: new Set(keys) })
    }
  }

  /**
   * Commit an author's live edits as one `edit` revision: the head board with the items that
   * author touched set to their current values, so another author's open edits stay out.
   * Nothing is committed when that board is the head's. If it does not parse (the author's
   * edits need someone else's), every open group is committed together, as the current board;
   * that revision names every author, and stores an author id only if they are all one account.
   */
  private closeGroup(key: string): void {
    const group = this.groups.get(key)
    if (!group) return
    clearTimeout(group.timer)
    this.groups.delete(key)
    const { author } = group
    const head = getRevision(this.db, this.id, this.head)
    if (!head) return this.commitEdit(this.board, author, group.authorId)
    const composed = parseBoard(withItems(head.board, this.board, group.keys))
    if (composed.ok) {
      if (sameItems(head.board, composed.board)) return
      return this.commitEdit(composed.board, author, group.authorId)
    }
    const all = [group, ...this.groups.values()]
    for (const g of all) clearTimeout(g.timer)
    this.groups.clear()
    if (sameItems(head.board, this.board)) return
    const accounts = new Set(all.map(g => g.authorId))
    this.commitEdit(this.board, all.map(g => g.author).join(', '), accounts.size === 1 ? group.authorId : null)
  }

  private commitEdit(board: BoardFile, author: string, authorId: string | null): void {
    this.head = commitRevision(this.db, this.id, { board, author, how: 'edit', authorId })
    this.board = { ...this.board, revision: this.head }
    // The commit stored `board` as current; the live board may hold other authors' open edits.
    if (!sameItems(board, this.board)) saveCurrent(this.db, this.id, this.board)
    this.writeServerMap()
  }

  private closeGroups(): void {
    for (const key of [...this.groups.keys()]) this.closeGroup(key)
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
