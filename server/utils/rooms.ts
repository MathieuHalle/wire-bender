import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { parseBoard, type BoardFile } from '~core/schema'
import { undoState } from '#shared/undoState'
import { RECORDS, SECTION_NAMES, boardToDoc, docToBoard, itemKey, sameItems, unknownSingles, withItems, writeBoard } from '#shared/yboard'
import type { Db } from '../db'
import { onTokensRevoked } from './tokenEvents'
import type { Role } from './boardAccess'
import { MAX_BOARD_BYTES, boardBefore, commitRevision, getBoard, getRevision, listRevisions, recover, saveCurrent } from './boards'

/** Live updates from one author join one revision until that author has been idle this long. */
export const GROUP_IDLE_MS = 2000

/** The largest presence update a peer may send: a name, an avatar URL and a colour fit many times. */
export const MAX_AWARENESS_BYTES = 8192

/** The most presence client ids one peer may have (y-websocket uses one per doc). */
export const MAX_PEER_CLIENTS = 4

/** How long a token's presence stays after its last write (spec §6). */
export const TOKEN_PRESENCE_MS = 30_000

/**
 * The first presence client id reserved for a token. Yjs client ids are 32-bit, so no real
 * peer ever has one this high, and a peer that names one is refused (receiveAwareness).
 */
export const TOKEN_CLIENT_BASE = 2 ** 32

/** The origin of the room's own presence changes (a token's entry): never a peer id. */
const TOKEN_ORIGIN = Symbol('token presence')

/** A personal API token at work on the board (never the token string). */
export interface ActiveToken { id: string, name: string }

/** One entry of an awareness update: a client id, its clock and its state as sent (JSON). */
interface AwarenessEntry { client: number, clock: number, state: string }

/** An awareness update's entries (y-protocols: count, then id, clock, state each). */
function awarenessEntries(update: Uint8Array): AwarenessEntry[] {
  const d = decoding.createDecoder(update)
  const n = decoding.readVarUint(d)
  const entries: AwarenessEntry[] = []
  for (let i = 0; i < n; i++) {
    entries.push({ client: decoding.readVarUint(d), clock: decoding.readVarUint(d), state: decoding.readVarString(d) })
  }
  return entries
}

/** An entry that removes its client's presence (y-protocols sends the state `null`). */
const isRemoval = (state: string): boolean => state.trim() === 'null'

/** An awareness update of `entries`, in the y-protocols format. */
function encodeEntries(entries: readonly AwarenessEntry[]): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, entries.length)
  for (const { client, clock, state } of entries) {
    encoding.writeVarUint(e, client)
    encoding.writeVarUint(e, clock)
    encoding.writeVarString(e, state)
  }
  return encoding.toUint8Array(e)
}

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

/**
 * Who a peer is in presence, set by the server: its account's name and avatar, `Guest`, or
 * a token's name with `kind: 'token'` (a socket opened with a token).
 */
export interface Presence { name: string, avatar?: string, kind?: 'token' }

/**
 * How a peer joins: its access, the account its edits are by, and its presence. Without
 * `presence` (local mode) the peer names itself (`Local · <device>`).
 */
export interface JoinOptions extends PeerAccess { authorId?: string | null, tokenId?: string | null, presence?: Presence }

/** Access changed, or never allowed this: a view peer tried to edit. */
export const CLOSE_ACCESS = 4403
export const VIEW_ONLY: Received = { ok: false, reason: 'view only', code: CLOSE_ACCESS }
const NOT_JOINED: Received = { ok: false, reason: 'not in this room', code: CLOSE_ACCESS }
/** An edit-link peer's update that changes the board's name (spec §5: only the owner renames). */
export const OWNER_RENAMES = 'Only the owner can rename the board.'

/**
 * `authorId`: the account the revision is by ('local' for the local user), null for none.
 * `tokenId`: the personal API token it was made with, if any.
 */
export interface WriteMeta { author: string, how: string, target?: number, authorId?: string | null, tokenId?: string | null }

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
interface Group { author: string, authorId: string | null, tokenId: string | null, timer: ReturnType<typeof setTimeout>, keys: Set<string> }

const groupKey = (author: string, authorId: string | null, tokenId: string | null): string => JSON.stringify([authorId, tokenId, author])
const rooms = new Map<string, Room>()

// R7: a revoked token (or one whose user is suspended or deleted) leaves every board's presence at once.
onTokensRevoked((ids) => {
  for (const room of rooms.values()) for (const id of ids) room.tokenGone(id)
})

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
  private readonly peers = new Map<string, { author: string, authorId: string | null, tokenId: string | null, link: PeerLink, clients: Set<number>, access: PeerAccess, presence?: Presence }>()
  private readonly groups = new Map<string, Group>()
  /** Each token's server-made presence entry, by token id: its reserved client id and expiry. */
  private readonly tokens = new Map<string, { client: number, timer: ReturnType<typeof setTimeout> }>()
  private nextTokenClient = TOKEN_CLIENT_BASE
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
        // Updated too: a state no peer owned yet (receiveAwareness drops another peer's)
        // belongs to the sender from then on, so it goes when that peer leaves.
        for (const c of [...added, ...updated]) from.clients.add(c)
        for (const c of removed) from.clients.delete(c)
        // A stamped peer's name and avatar are the server's, whatever it sent and under
        // whichever client id (a forged one shows the sender's own name). Only the server
        // says a presence is a token.
        for (const c of [...added, ...updated]) this.stamp(c, from.presence)
      }
      const changed = [...added, ...updated, ...removed]
      const message = encodeAwarenessUpdate(this.awareness, changed)
      for (const [peerId, peer] of this.peers) if (peerId !== origin) safely(() => peer.link.awareness(message))
    })
  }

  /**
   * Overwrite the name, avatar and kind in client `c`'s presence with `presence`. Without one
   * (local mode: the device names itself) only a `kind` the client claimed is dropped.
   */
  private stamp(c: number, presence: Presence | undefined): void {
    const state = this.awareness.states.get(c)
    if (!state) return
    const sent = typeof state.user === 'object' && state.user !== null ? state.user as Record<string, unknown> : null
    if (!presence) {
      if (sent && 'kind' in sent) {
        const { kind: _kind, ...user } = sent
        this.awareness.states.set(c, { ...state, user })
      }
      return
    }
    const { avatar: _avatar, kind: _kind, ...rest } = sent ?? {}
    const user: Record<string, unknown> = { ...rest, name: presence.name }
    if (presence.avatar) user.avatar = presence.avatar
    if (presence.kind) user.kind = presence.kind
    this.awareness.states.set(c, { ...state, user })
  }

  /**
   * A token just changed the board: its presence entry `{ user: { name, kind: 'token' } }`,
   * under a client id reserved for it in this room, is set or renewed for every peer (and
   * each new joiner), until TOKEN_PRESENCE_MS after the last call or the room closes.
   */
  tokenActive(token: ActiveToken): void {
    if (this.closed) return
    // A socket the token has open already shows it (stamped as a token): not twice.
    if ([...this.peers.values()].some(p => p.tokenId === token.id && p.clients.size > 0)) return
    const known = this.tokens.get(token.id)
    clearTimeout(known?.timer)
    const client = known?.client ?? this.nextTokenClient++
    // Newer than anything sent under this id (applyAwarenessUpdate ignores an older or equal clock).
    const clock = (this.awareness.meta.get(client)?.clock ?? 0) + 1
    const timer = setTimeout(() => this.tokenGone(token.id), TOKEN_PRESENCE_MS)
    this.tokens.set(token.id, { client, timer })
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 1)
    encoding.writeVarUint(e, client)
    encoding.writeVarUint(e, clock)
    encoding.writeVarString(e, JSON.stringify({ user: { name: token.name, kind: 'token' } }))
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(e), TOKEN_ORIGIN)
  }

  /** Remove a token's presence entry (it went quiet, was revoked, or the room is closing). */
  tokenGone(tokenId: string): void {
    const entry = this.tokens.get(tokenId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.tokens.delete(tokenId)
    if (this.awareness.states.has(entry.client)) removeAwarenessStates(this.awareness, [entry.client], TOKEN_ORIGIN)
  }

  private tokensGone(): void {
    for (const tokenId of [...this.tokens.keys()]) this.tokenGone(tokenId)
  }

  /**
   * Add a peer. It is sent the presence of everyone already here; the doc itself comes
   * through the sync protocol. A peer joined without `access` is the owner by board id.
   */
  join(peerId: string, author: string, link: PeerLink, options: JoinOptions = { role: 'owner', viaLink: false }): void {
    const { authorId = null, tokenId = null, role, viaLink, presence } = options
    this.peers.set(peerId, { author, authorId, tokenId, link, clients: new Set(), access: { role, viaLink }, presence })
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

  /** The token a joined peer's socket was opened with, or null. */
  peerTokenId(peerId: string): string | null {
    return this.peers.get(peerId)?.tokenId ?? null
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
    this.restartGroup(author, peer.authorId, peer.tokenId, checked.keys)
    return { ok: true }
  }

  /**
   * Apply a peer's presence and relay it to the others (R6). Entries naming a client id
   * another peer has, or one reserved for tokens, are dropped and the rest applied: a
   * y-websocket client sends back every presence change it receives, so those are mostly
   * echoes, and a forgery is never stored or relayed either way. A removal applies only to
   * the sender's own ids, and never counts toward the cap. Refused whole (nothing
   * stored or relayed, and the socket closes with 4400) when it is over MAX_AWARENESS_BYTES,
   * malformed, or the entries kept would give this peer more than MAX_PEER_CLIENTS ids.
   */
  receiveAwareness(peerId: string, update: Uint8Array): Received {
    const peer = this.peers.get(peerId)
    if (!peer) return NOT_JOINED
    if (update.byteLength > MAX_AWARENESS_BYTES) return { ok: false, reason: `the presence update is larger than ${MAX_AWARENESS_BYTES} bytes` }
    try {
      const entries = awarenessEntries(update)
      const others = [...this.peers].filter(([otherId]) => otherId !== peerId).map(([, other]) => other.clients)
      // A removal (null state) applies only to the sender's own ids: anything else is an echo
      // of someone leaving (or a forgery), never counted toward the cap nor claiming an id.
      const kept = entries.filter(({ client, state }) => isRemoval(state)
        ? peer.clients.has(client)
        : client < TOKEN_CLIENT_BASE && !others.some(clients => clients.has(client)))
      const claimed = kept.filter(e => !isRemoval(e.state)).map(e => e.client)
      if (new Set([...peer.clients, ...claimed]).size > MAX_PEER_CLIENTS) return { ok: false, reason: `a peer may have at most ${MAX_PEER_CLIENTS} presence clients` }
      if (kept.length === 0) return { ok: true }
      applyAwarenessUpdate(this.awareness, kept.length === entries.length ? update : encodeEntries(kept), peerId)
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
    const n = commitRevision(this.db, this.id, { board: next, author: meta.author, how: meta.how, target: meta.target, authorId: meta.authorId, tokenId: meta.tokenId })
    this.board = { ...next, revision: n }
    this.head = n
    this.writeServerMap()
    this.dropIfEmpty()
    return n
  }

  /** Revert the top of the board's undo stack. `null` when there is nothing to undo. */
  undo(author: string, authorId: string | null = null, tokenId: string | null = null): number | null {
    this.closeGroups()
    const { undo } = this.stacks()
    if (undo === null) return this.nothing()
    return this.serverWrite(boardBefore(this.db, this.id, undo), { author, how: 'undo', target: undo, authorId, tokenId })
  }

  /** Restore the top of the board's redo stack. `null` when there is nothing to redo. */
  redo(author: string, authorId: string | null = null, tokenId: string | null = null): number | null {
    this.closeGroups()
    const { redo } = this.stacks()
    const rev = redo === null ? null : getRevision(this.db, this.id, redo)
    if (redo === null || !rev) return this.nothing()
    return this.serverWrite(rev.board, { author, how: 'redo', target: redo, authorId, tokenId })
  }

  /** Remove a peer and its presence, and close its author's group. The last leave saves and drops the room. */
  leave(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      this.peers.delete(peerId)
      this.closeGroup(groupKey(peer.author, peer.authorId, peer.tokenId))
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
    this.tokensGone()
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

  private restartGroup(author: string, authorId: string | null, tokenId: string | null, keys: Set<string>): void {
    const key = groupKey(author, authorId, tokenId)
    const group = this.groups.get(key)
    clearTimeout(group?.timer)
    const timer = setTimeout(() => this.closeGroup(key), GROUP_IDLE_MS)
    if (group) {
      group.timer = timer
      for (const k of keys) group.keys.add(k)
    } else {
      this.groups.set(key, { author, authorId, tokenId, timer, keys: new Set(keys) })
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
    if (!head) return this.commitEdit(this.board, author, group.authorId, group.tokenId)
    const composed = parseBoard(withItems(head.board, this.board, group.keys))
    if (composed.ok) {
      if (sameItems(head.board, composed.board)) return
      return this.commitEdit(composed.board, author, group.authorId, group.tokenId)
    }
    const all = [group, ...this.groups.values()]
    for (const g of all) clearTimeout(g.timer)
    this.groups.clear()
    if (sameItems(head.board, this.board)) return
    const accounts = new Set(all.map(g => g.authorId))
    const tokens = new Set(all.map(g => g.tokenId))
    const one = accounts.size === 1
    this.commitEdit(this.board, all.map(g => g.author).join(', '), one ? group.authorId : null, one && tokens.size === 1 ? group.tokenId : null)
  }

  private commitEdit(board: BoardFile, author: string, authorId: string | null, tokenId: string | null): void {
    this.head = commitRevision(this.db, this.id, { board, author, how: 'edit', authorId, tokenId })
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
    this.tokensGone()
    this.closed = true
    if (rooms.get(this.id) === this) rooms.delete(this.id)
    this.awareness.destroy()
    this.doc.destroy()
  }
}
