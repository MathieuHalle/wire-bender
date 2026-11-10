import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardFile } from '../../core/schema'
import { openDb, type Db } from '../../server/db'
import { boards, identities, linkVisits, revisions, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import * as api from '../../server/utils/api'
import { recordVisit, unlockEntry } from '../../server/utils/boardAccess'
import { createBoard, getBoardRow, listRevisions } from '../../server/utils/boards'
import {
  CREATES_PER_MINUTE, FREE_BOARD_LIMIT, PREMIUM_BOARD_LIMIT, TRASH_DAYS,
  PURGE_EVERY_MS, deleteAccount, deleteBoardForGood, fork, purge, resetCreateRate, restoreAccount, restoreSession, schedulePurge, trashBoard, untrashBoard, withCreateLimit
} from '../../server/utils/lifecycle'
import { openRoom, type PeerLink } from '../../server/utils/rooms'
import { getSharing, patchSharing, regenerateLink } from '../../server/utils/sharing'
import type { Who } from '../../server/utils/who'

let dir: string
let db: Db
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
const DAY = 24 * 3600_000
const NOT_FOUND = { status: 404, body: { error: 'not found' } }
const ANON: Who = { kind: 'anonymous' }
const LOCAL: Who = { kind: 'local', userId: 'local', author: 'Local · This computer' }

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-lifecycle-'))
  db = openDb(dir)
  resetCreateRate()
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function user(name: string, isPremium = false): Who & { kind: 'user' } {
  const r = signIn(db, 'github', { id: `gh-${name}`, name })
  if (!r.ok) throw new Error('sign-in failed')
  db.update(users).set({ isPremium: isPremium ? 1 : 0 }).where(eq(users.id, r.userId)).run()
  return { kind: 'user', userId: r.userId, author: name, isAdmin: false, isPremium }
}

/** A board owned by `owner`, with a second revision, and `set` applied. */
function board(owner: Who & { userId: string }, set: Partial<typeof boards.$inferInsert> = {}): { id: string, linkId: string } {
  const { id } = createBoard(db, fixture, 'import', owner.kind === 'user' ? owner.author : 'Local', owner.userId, owner.userId)
  expect(api.putBoard(db, { key: id, who: owner }, JSON.stringify({ board: { ...fixture, name: 'Second' } })).status).toBe(200)
  if (Object.keys(set).length > 0) db.update(boards).set(set).where(eq(boards.id, id)).run()
  return { id, linkId: getBoardRow(db, id)!.linkId }
}

/** A peer in the board's live room, recording how it was closed. */
function joinPeer(boardId: string, peerId: string, viaLink: boolean, role: 'owner' | 'edit' | 'view' = 'edit') {
  const closed: { code: number, reason: string }[] = []
  const link: PeerLink = { update: () => {}, awareness: () => {}, close: (code, reason) => closed.push({ code, reason }) }
  openRoom(db, boardId)!.join(peerId, peerId, link, { role, viaLink })
  return closed
}

const deleteBody = (confirm: unknown) => JSON.stringify({ confirm })

describe('purge', () => {
  it('purge keeps boards trashed 29 days ago', () => {
    const ada = user('Ada')
    const now = Date.now()
    const b = board(ada, { trashedAt: now - 29 * DAY })
    expect(TRASH_DAYS).toBe(30)
    purge(db, now)
    expect(getBoardRow(db, b.id)).toMatchObject({ trashedAt: now - 29 * DAY })
    expect(listRevisions(db, b.id)).toHaveLength(2)
    // Not trashed at all: never touched.
    const kept = board(ada)
    purge(db, now + 365 * DAY)
    expect(getBoardRow(db, kept.id)).toBeDefined()
  })

  it('purge removes boards trashed 31 days ago and their revisions', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const now = Date.now()
    const b = board(ada, { trashedAt: now - 31 * DAY })
    recordVisit(db, bob, { ok: true, boardId: b.id, role: 'view', signInToEdit: false, viaLink: true }, b.linkId)
    const other = board(ada)
    const closed = joinPeer(b.id, 'ada', false, 'owner')
    expect(purge(db, now)).toEqual({ boards: 1, users: 0 })
    expect(getBoardRow(db, b.id)).toBeUndefined()
    expect(db.select().from(revisions).where(eq(revisions.boardId, b.id)).all()).toEqual([])
    expect(db.select().from(linkVisits).where(eq(linkVisits.boardId, b.id)).all()).toEqual([])
    expect(closed).toEqual([{ code: 4404, reason: 'no such board' }])
    expect(listRevisions(db, other.id)).toHaveLength(2)
  })

  it('purge keeps an account deleted 29 days ago, and removes one deleted 31 days ago with its boards, identities and visits', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const now = Date.now()
    const adaBoard = board(ada)
    const bobBoard = board(bob)
    recordVisit(db, ada, { ok: true, boardId: bobBoard.id, role: 'view', signInToEdit: false, viaLink: true }, bobBoard.linkId)
    db.update(users).set({ deletedAt: now - 29 * DAY }).where(eq(users.id, ada.userId)).run()
    expect(purge(db, now)).toEqual({ boards: 0, users: 0 })
    expect(getBoardRow(db, adaBoard.id)).toBeDefined()

    expect(purge(db, now + 2 * DAY)).toEqual({ boards: 1, users: 1 })
    expect(db.select().from(users).where(eq(users.id, ada.userId)).get()).toBeUndefined()
    expect(getBoardRow(db, adaBoard.id)).toBeUndefined()
    expect(db.select().from(revisions).where(eq(revisions.boardId, adaBoard.id)).all()).toEqual([])
    expect(db.select().from(identities).where(eq(identities.userId, ada.userId)).all()).toEqual([])
    expect(db.select().from(linkVisits).where(eq(linkVisits.userId, ada.userId)).all()).toEqual([])
    // Bob is untouched.
    expect(getBoardRow(db, bobBoard.id)).toBeDefined()
    expect(listRevisions(db, bobBoard.id)).toHaveLength(2)
  })

  it('runs at start and every 24 h, without keeping the process alive', () => {
    vi.useFakeTimers()
    try {
      const ada = user('Ada')
      const b = board(ada, { trashedAt: Date.now() - 31 * DAY })
      const runs: number[] = []
      const stop = schedulePurge(db, { log: r => runs.push(r.boards) })
      expect(PURGE_EVERY_MS).toBe(DAY)
      expect(getBoardRow(db, b.id)).toBeUndefined()
      const later = board(ada)
      db.update(boards).set({ trashedAt: Date.now() - 29 * DAY }).where(eq(boards.id, later.id)).run()
      vi.advanceTimersByTime(DAY)
      expect(getBoardRow(db, later.id)).toBeDefined()
      vi.advanceTimersByTime(2 * DAY)
      expect(getBoardRow(db, later.id)).toBeUndefined()
      expect(runs).toEqual([1, 0, 1, 0])
      expect(stop.timer.hasRef()).toBe(false)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an account\'s purge is all or nothing', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const now = Date.now()
    const b = board(ada)
    const trashed = board(bob, { trashedAt: now - 31 * DAY })
    db.update(users).set({ deletedAt: now - 31 * DAY }).where(eq(users.id, ada.userId)).run()
    db.$client.exec('CREATE TRIGGER no_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, \'boom\'); END')
    expect(() => purge(db, now)).toThrow('boom')
    // Nothing of Ada's went: her board, its history, her identity and her row are all there.
    expect(getBoardRow(db, b.id)).toBeDefined()
    expect(listRevisions(db, b.id)).toHaveLength(2)
    expect(db.select().from(identities).where(eq(identities.userId, ada.userId)).all()).toHaveLength(1)
    expect(db.select().from(users).where(eq(users.id, ada.userId)).get()).toBeDefined()
    // A board-only purge is its own transaction: Bob's trashed board went before.
    expect(getBoardRow(db, trashed.id)).toBeUndefined()
    db.$client.exec('DROP TRIGGER no_user_delete')
    expect(purge(db, now)).toEqual({ boards: 1, users: 1 })
    expect(getBoardRow(db, b.id)).toBeUndefined()
  })

  it('after a purge the same GitHub account signs in as a new account, not "taken"', () => {
    const ada = user('Ada')
    db.update(users).set({ deletedAt: Date.now() - 31 * DAY }).where(eq(users.id, ada.userId)).run()
    purge(db, Date.now())
    const again = signIn(db, 'github', { id: 'gh-Ada', name: 'Ada' })
    expect(again.ok).toBe(true)
    if (again.ok) {
      expect(again.userId).not.toBe(ada.userId)
      expect(again.deleted).toBeUndefined()
    }
  })
})

describe('trash', () => {
  it('untrash keeps every revision', () => {
    const ada = user('Ada')
    const b = board(ada)
    const before = listRevisions(db, b.id)
    expect(trashBoard(db, { key: b.id, who: ada })).toMatchObject({ status: 200 })
    expect(getBoardRow(db, b.id)!.trashedAt).not.toBeNull()
    expect(api.getBoardResponse(db, { key: b.linkId, who: user('Bob') })).toEqual(NOT_FOUND)
    expect(untrashBoard(db, { key: b.id, who: ada })).toMatchObject({ status: 200 })
    expect(getBoardRow(db, b.id)!.trashedAt).toBeNull()
    expect(listRevisions(db, b.id)).toEqual(before)
    expect(api.getBoardResponse(db, { key: b.linkId, who: user('Bob') }).status).toBe(200)
  })

  it('trashing twice keeps the first date', () => {
    const ada = user('Ada')
    const b = board(ada)
    trashBoard(db, { key: b.id, who: ada }, 1000)
    trashBoard(db, { key: b.id, who: ada }, 2000)
    expect(getBoardRow(db, b.id)!.trashedAt).toBe(1000)
  })

  it('trash and untrash kick every non-owner peer with 4403', () => {
    const ada = user('Ada')
    const b = board(ada, { visibility: 'edit' })
    const owner = joinPeer(b.id, 'ada', false, 'owner')
    const visitor = joinPeer(b.id, 'bob', true, 'edit')
    trashBoard(db, { key: b.id, who: ada })
    expect(visitor).toEqual([{ code: 4403, reason: 'access changed' }])
    expect(owner).toEqual([])
    const again = joinPeer(b.id, 'cy', true, 'view')
    untrashBoard(db, { key: b.id, who: ada })
    expect(again).toEqual([{ code: 4403, reason: 'access changed' }])
    expect(owner).toEqual([])
  })

  it('edit-link visitor can\'t trash or rename', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const b = board(ada, { visibility: 'edit' })
    for (const who of [bob, ANON]) {
      for (const key of [b.linkId, b.id]) {
        expect(trashBoard(db, { key, who }), key).toEqual(NOT_FOUND)
        expect(untrashBoard(db, { key, who }), key).toEqual(NOT_FOUND)
        expect(api.renameBoard(db, { key, who }, JSON.stringify({ name: 'X' })), key).toEqual(NOT_FOUND)
        expect(deleteBoardForGood(db, { key, who }, deleteBody('Second')), key).toEqual(NOT_FOUND)
      }
    }
    expect(getBoardRow(db, b.id)).toMatchObject({ trashedAt: null, name: 'Second' })
  })

  it('owner-only routes are the plain 404 for a password-link key', async () => {
    const ada = user('Ada', true)
    const bob = user('Bob', true)
    const b = board(ada, { visibility: 'edit', passwordHash: 'h:secret' })
    const base = 'https://wire.example.org'
    const unknown = getSharing(db, { key: 'no-such-board', who: bob }, base)
    expect(unknown).toEqual(NOT_FOUND)
    for (const unlocked of [[], [unlockEntry(b.linkId, 'h:secret')]]) {
      const req = { key: b.linkId, who: bob, unlocked }
      expect(getSharing(db, req, base)).toEqual(unknown)
      expect(await patchSharing(db, req, JSON.stringify({ visibility: 'view' }), { base, hash: async p => `h:${p}`, seal: p => `s:${p}` })).toEqual(unknown)
      expect(trashBoard(db, req)).toEqual(unknown)
      expect(api.renameBoard(db, req, JSON.stringify({ name: 'X' }))).toEqual(unknown)
    }
    expect(getBoardRow(db, b.id)).toMatchObject({ visibility: 'edit', trashedAt: null })
  })

  it('untrash is refused at the board limit', () => {
    const ada = user('Ada')
    const b = board(ada, { trashedAt: Date.now() })
    for (let i = 0; i < FREE_BOARD_LIMIT; i++) createBoard(db, fixture, 'import', 'Ada', ada.userId)
    expect(untrashBoard(db, { key: b.id, who: ada })).toEqual({ status: 403, body: { error: 'Board limit reached (200). Move some to the trash or ask for premium.' } })
    expect(getBoardRow(db, b.id)!.trashedAt).not.toBeNull()
  })
})

describe('delete for good', () => {
  it('works only on a trashed board, with its exact name', () => {
    const ada = user('Ada')
    const b = board(ada)
    expect(deleteBoardForGood(db, { key: b.id, who: ada }, deleteBody('Second'))).toEqual({ status: 409, body: { error: 'Move the board to the trash first.' } })
    trashBoard(db, { key: b.id, who: ada })
    for (const confirm of ['second', 'Second ', '', undefined, 3]) {
      const r = deleteBoardForGood(db, { key: b.id, who: ada }, deleteBody(confirm))
      expect(r.status, String(confirm)).toBe(422)
      expect((r.body as { errors: string[] }).errors[0]).toContain('Second')
    }
    expect(deleteBoardForGood(db, { key: b.id, who: ada }, '{ nope').status).toBe(422)
    expect(getBoardRow(db, b.id)).toBeDefined()

    const closed = joinPeer(b.id, 'ada', false, 'owner')
    expect(deleteBoardForGood(db, { key: b.id, who: ada }, deleteBody('Second'))).toEqual({ status: 200, body: { ok: true } })
    expect(closed).toEqual([{ code: 4404, reason: 'no such board' }])
    expect(getBoardRow(db, b.id)).toBeUndefined()
    expect(db.select().from(revisions).where(eq(revisions.boardId, b.id)).all()).toEqual([])
    expect(api.getBoardResponse(db, { key: b.id, who: ada })).toEqual(NOT_FOUND)
  })

  it('confirms with the live name, as the board shows it', () => {
    const ada = user('Ada')
    const b = board(ada)
    trashBoard(db, { key: b.id, who: ada })
    // A rename by a live edit: in the current board at once, in the name column only when its group commits.
    db.update(boards).set({ current: JSON.stringify({ ...fixture, name: 'Live' }) }).where(eq(boards.id, b.id)).run()
    const stale = deleteBoardForGood(db, { key: b.id, who: ada }, deleteBody('Second'))
    expect(stale.status).toBe(422)
    expect((stale.body as { errors: string[] }).errors[0]).toContain('"Live"')
    expect(deleteBoardForGood(db, { key: b.id, who: ada }, deleteBody('Live'))).toEqual({ status: 200, body: { ok: true } })
    expect(getBoardRow(db, b.id)).toBeUndefined()
  })

  it('works for the local user', () => {
    const b = board(LOCAL)
    expect(trashBoard(db, { key: b.id, who: LOCAL }).status).toBe(200)
    expect(untrashBoard(db, { key: b.id, who: LOCAL }).status).toBe(200)
    trashBoard(db, { key: b.id, who: LOCAL })
    expect(deleteBoardForGood(db, { key: b.id, who: LOCAL }, deleteBody('Second')).status).toBe(200)
  })
})

describe('fork', () => {
  it('fork copies the board, not the history', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const b = board(ada)
    const r = fork(db, { key: b.linkId, who: bob })
    expect(r.status).toBe(200)
    const id = (r.body as { id: string }).id
    const row = getBoardRow(db, id)!
    expect(row).toMatchObject({ ownerId: bob.userId, forkedFrom: b.id, name: 'Second', head: 1, trashedAt: null, visibility: 'view' })
    expect(row.linkId).not.toBe(b.linkId)
    const revs = listRevisions(db, id)
    expect(revs).toEqual([expect.objectContaining({ n: 1, how: 'fork', summary: 'forked from Second', author: 'Bob' })])
    expect(db.select().from(revisions).where(eq(revisions.boardId, id)).get()!.authorId).toBe(bob.userId)
    const got = api.getBoardResponse(db, { key: id, who: bob }).body as { board: BoardFile, forkedFrom: unknown, role: string }
    const source = api.getBoardResponse(db, { key: b.id, who: ada }).body as { board: BoardFile }
    expect({ ...got.board, revision: 0 }).toEqual({ ...source.board, revision: 0 })
    expect(got.role).toBe('owner')
    expect(got.forkedFrom).toEqual({ key: b.linkId, name: 'Second' })
    // The source is unchanged.
    expect(listRevisions(db, b.id)).toHaveLength(2)
  })

  it('takes live edits not yet committed as a revision', () => {
    const ada = user('Ada')
    const b = board(ada)
    db.update(boards).set({ current: JSON.stringify({ ...fixture, name: 'Live' }) }).where(eq(boards.id, b.id)).run()
    const id = (fork(db, { key: b.linkId, who: user('Bob') }).body as { id: string }).id
    expect(getBoardRow(db, id)!.name).toBe('Live')
  })

  it('on your own board it is a duplicate named "(copy)"', () => {
    const ada = user('Ada')
    const b = board(ada)
    const id = (fork(db, { key: b.id, who: ada }).body as { id: string }).id
    expect(getBoardRow(db, id)).toMatchObject({ name: 'Second (copy)', ownerId: ada.userId, forkedFrom: b.id })
    expect(listRevisions(db, id)[0]).toMatchObject({ how: 'fork', summary: 'forked from Second' })
    expect((api.getBoardResponse(db, { key: id, who: ada }).body as { forkedFrom: unknown }).forkedFrom).toEqual({ key: b.id, name: 'Second' })
    // The local user duplicates too.
    const local = board(LOCAL)
    const copy = fork(db, { key: local.id, who: LOCAL })
    expect(getBoardRow(db, (copy.body as { id: string }).id)).toMatchObject({ name: 'Second (copy)', ownerId: 'local' })
  })

  it('needs view and a signed-in user', () => {
    const ada = user('Ada')
    const b = board(ada)
    expect(fork(db, { key: b.linkId, who: ANON })).toEqual({ status: 403, body: { error: 'Sign in to fork.' } })
    expect(fork(db, { key: b.id, who: user('Bob') })).toEqual(NOT_FOUND)
    expect(fork(db, { key: 'no-such-board', who: user('Bob') })).toEqual(NOT_FOUND)
    db.update(boards).set({ visibility: 'private' }).where(eq(boards.id, b.id)).run()
    expect(fork(db, { key: b.linkId, who: user('Bob') })).toEqual(NOT_FOUND)
    db.update(boards).set({ visibility: 'view', passwordHash: 'h:pw' }).where(eq(boards.id, b.id)).run()
    expect(fork(db, { key: b.linkId, who: user('Bob') })).toEqual({ status: 401, body: { password: true } })
    expect(fork(db, { key: b.linkId, who: user('Bob'), unlocked: [unlockEntry(b.linkId, 'h:pw')] }).status).toBe(200)
  })

  it('forkedFrom hides when the source turns private', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const b = board(ada)
    const id = (fork(db, { key: b.linkId, who: bob }).body as { id: string }).id
    const forkedFrom = () => (api.getBoardResponse(db, { key: id, who: bob }).body as { forkedFrom: unknown }).forkedFrom
    expect(forkedFrom()).toEqual({ key: b.linkId, name: 'Second' })
    db.update(boards).set({ visibility: 'private' }).where(eq(boards.id, b.id)).run()
    expect(forkedFrom()).toBeNull()
    db.update(boards).set({ visibility: 'edit' }).where(eq(boards.id, b.id)).run()
    expect(forkedFrom()).toEqual({ key: b.linkId, name: 'Second' })
    db.update(boards).set({ trashedAt: Date.now() }).where(eq(boards.id, b.id)).run()
    expect(forkedFrom()).toBeNull()
    db.update(boards).set({ trashedAt: null }).where(eq(boards.id, b.id)).run()
    db.update(users).set({ deletedAt: Date.now() }).where(eq(users.id, ada.userId)).run()
    expect(forkedFrom()).toBeNull()
    db.update(users).set({ deletedAt: null }).where(eq(users.id, ada.userId)).run()
    expect(forkedFrom()).toEqual({ key: b.linkId, name: 'Second' })
    // Never shown to anyone but the fork's owner.
    db.update(boards).set({ visibility: 'view' }).where(eq(boards.id, id)).run()
    const viaLink = api.getBoardResponse(db, { key: getBoardRow(db, id)!.linkId, who: user('Cy') }).body as { forkedFrom: unknown }
    expect(viaLink.forkedFrom).toBeNull()
    expect(JSON.stringify(viaLink)).not.toContain(b.id)
    // Gone.
    trashBoard(db, { key: b.id, who: ada })
    deleteBoardForGood(db, { key: b.id, who: ada }, deleteBody('Second'))
    expect(forkedFrom()).toBeNull()
  })

  it('forkedFrom is null for good once the owner regenerates the link, and the new link shows nowhere (R12)', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const b = board(ada)
    db.update(boards).set({ visibility: 'edit' }).where(eq(boards.id, b.id)).run()
    const id = (fork(db, { key: b.linkId, who: bob }).body as { id: string }).id
    expect(getBoardRow(db, id)!.forkedFromLink).toBe(b.linkId)
    const got = () => api.getBoardResponse(db, { key: id, who: bob }).body as { forkedFrom: unknown }
    expect(got().forkedFrom).toEqual({ key: b.linkId, name: 'Second' })
    expect(regenerateLink(db, { key: b.id, who: ada }, 'https://wire.example.org').status).toBe(200)
    const fresh = getBoardRow(db, b.id)!.linkId
    expect(fresh).not.toBe(b.linkId)
    expect(got().forkedFrom).toBeNull()
    for (const r of [api.getBoardResponse(db, { key: id, who: bob }), api.listBoardsResponse(db, bob.userId, 'mine'), api.listBoardsResponse(db, bob.userId, 'shared'), api.listRevisionsResponse(db, { key: id, who: bob })]) {
      expect(JSON.stringify(r.body)).not.toContain(fresh)
    }
  })

  it('a fork of the forker\'s own board points back by board id, whatever its link (R12)', () => {
    const ada = user('Ada')
    const b = board(ada)
    const id = (fork(db, { key: b.id, who: ada }).body as { id: string }).id
    expect(getBoardRow(db, id)!.forkedFromLink).toBeNull()
    regenerateLink(db, { key: b.id, who: ada }, 'https://wire.example.org')
    expect((api.getBoardResponse(db, { key: id, who: ada }).body as { forkedFrom: unknown }).forkedFrom).toEqual({ key: b.id, name: 'Second' })
  })
})

describe('account deletion', () => {
  it('deleted account\'s links are 404, and restore brings them back', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const b = board(ada, { visibility: 'edit' })
    const visitor = joinPeer(b.id, 'bob', true, 'edit')
    expect(api.getBoardResponse(db, { key: b.linkId, who: bob }).status).toBe(200)
    deleteAccount(db, ada.userId, 5000)
    expect(db.select().from(users).where(eq(users.id, ada.userId)).get()!.deletedAt).toBe(5000)
    expect(visitor).toEqual([{ code: 4403, reason: 'access changed' }])
    expect(api.getBoardResponse(db, { key: b.linkId, who: bob })).toEqual(NOT_FOUND)
    expect(fork(db, { key: b.linkId, who: bob })).toEqual(NOT_FOUND)
    // A sign-in while deleted offers the restore (ruling R1).
    expect(signIn(db, 'github', { id: 'gh-Ada', name: 'Ada' })).toEqual({ ok: true, userId: ada.userId, deleted: true })

    expect(restoreAccount(db, ada.userId)).toBe(true)
    expect(db.select().from(users).where(eq(users.id, ada.userId)).get()!.deletedAt).toBeNull()
    expect(api.getBoardResponse(db, { key: b.linkId, who: bob }).status).toBe(200)
    expect(listRevisions(db, b.id)).toHaveLength(2)
    expect(signIn(db, 'github', { id: 'gh-Ada', name: 'Ada' })).toEqual({ ok: true, userId: ada.userId })
  })

  it('restoreSession restores a pendingDeletion session, and says gone when the row went meanwhile', () => {
    const ada = user('Ada')
    deleteAccount(db, ada.userId, 1000)
    const row = db.select().from(users).where(eq(users.id, ada.userId)).get()!
    const pending = { who: ANON, account: row, pendingDeletion: true }
    expect(restoreSession(db, pending)).toEqual({ kind: 'restored', userId: ada.userId })
    expect(db.select().from(users).where(eq(users.id, ada.userId)).get()!.deletedAt).toBeNull()
    // Restored already (another tab): still the account, nothing changed.
    expect(restoreSession(db, pending)).toEqual({ kind: 'restored', userId: ada.userId })
    expect(restoreSession(db, { who: ANON, account: null, pendingDeletion: false })).toEqual({ kind: 'anonymous' })
    // Purged between reading the session and the restore.
    deleteAccount(db, ada.userId, 1000)
    db.delete(users).where(eq(users.id, ada.userId)).run()
    expect(restoreSession(db, pending)).toEqual({ kind: 'gone' })
  })

  it('deleting twice keeps the first date; the local user has no deletion', () => {
    const ada = user('Ada')
    deleteAccount(db, ada.userId, 1000)
    deleteAccount(db, ada.userId, 2000)
    expect(db.select().from(users).where(eq(users.id, ada.userId)).get()!.deletedAt).toBe(1000)
    expect(deleteAccount(db, 'local', 1000)).toBe(false)
    expect(restoreAccount(db, 'nobody')).toBe(false)
  })
})

describe('limits', () => {
  const create = (who: Who & { userId: string }, now?: number) =>
    withCreateLimit(db, who, () => api.createOrImport(db, JSON.stringify({ board: fixture }), 'x', who.userId), now)

  it('the 201st board is refused for a free account', () => {
    const ada = user('Ada')
    expect(FREE_BOARD_LIMIT).toBe(200)
    expect(PREMIUM_BOARD_LIMIT).toBe(2000)
    for (let i = 0; i < FREE_BOARD_LIMIT - 1; i++) createBoard(db, fixture, 'import', 'Ada', ada.userId)
    expect(create(ada).status).toBe(200)
    const refused = { status: 403, body: { error: 'Board limit reached (200). Move some to the trash or ask for premium.' } }
    expect(create(ada)).toEqual(refused)
    expect(fork(db, { key: db.select().from(boards).get()!.id, who: ada })).toEqual(refused)
    expect(db.select().from(boards).where(eq(boards.ownerId, ada.userId)).all()).toHaveLength(FREE_BOARD_LIMIT)
    // Trashed boards don't count.
    const one = db.select().from(boards).get()!
    trashBoard(db, { key: one.id, who: ada })
    expect(create(ada).status).toBe(200)
    // Premium: 2000.
    const pam = { ...user('Pam', true) }
    for (let i = 0; i < FREE_BOARD_LIMIT; i++) createBoard(db, fixture, 'import', 'Pam', pam.userId)
    expect(create(pam).status).toBe(200)
  })

  it('premium accounts stop at 2000', () => {
    const pam = user('Pam', true)
    const insert = db.$client.prepare('INSERT INTO boards (id, name, created_at, updated_at, current, head, owner_id, link_id) VALUES (?, ?, 0, 0, ?, 1, ?, ?)')
    db.$client.transaction(() => {
      for (let i = 0; i < PREMIUM_BOARD_LIMIT; i++) insert.run(`b${i}`, 'x', '{}', pam.userId, `l${i}`)
    })()
    expect(create(pam)).toEqual({ status: 403, body: { error: 'Board limit reached (2000). Move some to the trash.' } })
  })

  it('at most 30 creates and forks per user per minute', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    expect(CREATES_PER_MINUTE).toBe(30)
    const now = 1_000_000
    for (let i = 0; i < CREATES_PER_MINUTE - 1; i++) expect(create(ada, now + i).status).toBe(200)
    const b = db.select().from(boards).get()!
    expect(fork(db, { key: b.id, who: ada }, now + 40).status).toBe(200)
    const tooMany = { status: 429, body: { error: 'Too many new boards. Wait a minute and try again.' } }
    expect(create(ada, now + 50)).toEqual(tooMany)
    expect(fork(db, { key: b.id, who: ada }, now + 50)).toEqual(tooMany)
    // Per user.
    expect(create(bob, now + 50).status).toBe(200)
    // A refused or failed create does not count; a minute later it works again.
    expect(create(ada, now + 60_001).status).toBe(200)
    expect(withCreateLimit(db, bob, () => api.createOrImport(db, '{ nope', 'x', bob.userId), now + 60).status).toBe(422)
  })

  it('the local user has no limits', () => {
    for (let i = 0; i < CREATES_PER_MINUTE + 5; i++) expect(create(LOCAL as Who & { userId: string }, 1000).status).toBe(200)
  })
})
