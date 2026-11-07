import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BoardFile } from '../../core/schema'
import { openDb, type Db } from '../../server/db'
import { boards, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { MAX_UNLOCKED, MAX_WRONG_UNLOCKS, UNLOCK_WINDOW_MS, access, resetUnlocks, unlockLink, withUnlocked } from '../../server/utils/boardAccess'
import { createBoard, getBoardRow } from '../../server/utils/boards'
import type { Who } from '../../server/utils/who'

let dir: string
let db: Db
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-access-'))
  db = openDb(dir)
  resetUnlocks()
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

const LOCAL: Who = { kind: 'local', userId: 'local', author: 'Local' }
const ANON: Who = { kind: 'anonymous' }

function user(name: string): Who & { kind: 'user' } {
  const r = signIn(db, 'github', { id: `gh-${name}`, name })
  if (!r.ok) throw new Error('sign-in failed')
  return { kind: 'user', userId: r.userId, author: name, isAdmin: false, isPremium: false }
}

function board(ownerId: string, set: Partial<typeof boards.$inferInsert> = {}): { id: string, linkId: string } {
  const { id } = createBoard(db, fixture, 'import', 'x', ownerId)
  if (Object.keys(set).length > 0) db.update(boards).set(set).where(eq(boards.id, id)).run()
  return { id, linkId: getBoardRow(db, id)!.linkId }
}

// A stand-in for nuxt-auth-utils' verifyPassword: the "hash" is the password with a prefix.
const verify = async (hash: string, plain: string) => hash === `h:${plain}`

describe('access by board id', () => {
  it('board id is 404 for non-owners', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const b = board(ada.userId)
    expect(access(db, ada, b.id, [])).toEqual({ ok: true, boardId: b.id, role: 'owner', signInToEdit: false, viaLink: false })
    const unknown = access(db, bob, 'no-such-board', [])
    expect(unknown).toEqual({ ok: false, status: 404 })
    expect(access(db, bob, b.id, [])).toEqual(unknown)
    expect(access(db, ANON, b.id, [])).toEqual(unknown)
    expect(access(db, LOCAL, b.id, [])).toEqual(unknown)
  })

  it('the local user owns its boards', () => {
    const b = board('local')
    expect(access(db, LOCAL, b.id, [])).toMatchObject({ ok: true, role: 'owner', viaLink: false })
  })

  it('the owner reaches a trashed board by id', () => {
    const ada = user('Ada')
    const b = board(ada.userId, { trashedAt: Date.now() })
    expect(access(db, ada, b.id, [])).toMatchObject({ ok: true, role: 'owner' })
  })
})

describe('access by link', () => {
  it('view and edit follow the setting', () => {
    const ada = user('Ada')
    const bob = user('Bob')
    const v = board(ada.userId)
    const e = board(ada.userId, { visibility: 'edit' })
    expect(access(db, bob, v.linkId, [])).toEqual({ ok: true, boardId: v.id, role: 'view', signInToEdit: false, viaLink: true })
    expect(access(db, bob, e.linkId, [])).toEqual({ ok: true, boardId: e.id, role: 'edit', signInToEdit: false, viaLink: true })
    expect(access(db, ANON, v.linkId, [])).toMatchObject({ ok: true, role: 'view', signInToEdit: false })
  })

  it('anonymous on an edit link gets view with signInToEdit', () => {
    const b = board(user('Ada').userId, { visibility: 'edit' })
    expect(access(db, ANON, b.linkId, [])).toEqual({ ok: true, boardId: b.id, role: 'view', signInToEdit: true, viaLink: true })
  })

  it('the owner by link gets the link\'s role, not owner', () => {
    const ada = user('Ada')
    const b = board(ada.userId, { visibility: 'edit' })
    expect(access(db, ada, b.linkId, [])).toMatchObject({ ok: true, role: 'edit', viaLink: true })
  })

  it('private link is 404 even for the owner by link', () => {
    const ada = user('Ada')
    const b = board(ada.userId, { visibility: 'private' })
    expect(access(db, ada, b.linkId, [])).toEqual({ ok: false, status: 404 })
    expect(access(db, user('Bob'), b.linkId, [])).toEqual({ ok: false, status: 404 })
    expect(access(db, ANON, b.linkId, [])).toEqual({ ok: false, status: 404 })
    expect(access(db, ada, b.id, [])).toMatchObject({ ok: true, role: 'owner' })
  })

  it('trashed board is 404 by link', () => {
    const ada = user('Ada')
    const b = board(ada.userId, { visibility: 'edit', trashedAt: Date.now() })
    expect(access(db, user('Bob'), b.linkId, [])).toEqual({ ok: false, status: 404 })
    expect(access(db, ada, b.linkId, [])).toEqual({ ok: false, status: 404 })
  })

  it('a deleted owner\'s link is 404', () => {
    const ada = user('Ada')
    const b = board(ada.userId)
    db.update(users).set({ deletedAt: Date.now() }).where(eq(users.id, ada.userId)).run()
    expect(access(db, user('Bob'), b.linkId, [])).toEqual({ ok: false, status: 404 })
  })

  it('password link needs unlock, then opens', () => {
    const b = board(user('Ada').userId, { passwordHash: 'h:secret' })
    const bob = user('Bob')
    expect(access(db, bob, b.linkId, [])).toEqual({ ok: false, status: 401 })
    expect(access(db, ANON, b.linkId, ['another-link'])).toEqual({ ok: false, status: 401 })
    expect(access(db, bob, b.linkId, [b.linkId])).toMatchObject({ ok: true, role: 'view', viaLink: true })
  })
})

describe('unlock', () => {
  it('password link needs unlock, then opens', async () => {
    const b = board(user('Ada').userId, { passwordHash: 'h:secret' })
    expect(await unlockLink(db, b.linkId, 'nope', '203.0.113.9', verify)).toEqual({ status: 403, body: { error: 'Wrong password.' } })
    const r = await unlockLink(db, b.linkId, 'secret', '203.0.113.9', verify)
    expect(r).toEqual({ status: 200, body: { ok: true }, unlock: true })
  })

  it('five wrong passwords then 429', async () => {
    const b = board(user('Ada').userId, { passwordHash: 'h:secret' })
    const other = board(user('Bob').userId, { passwordHash: 'h:other' })
    const now = 1_000_000
    for (let i = 0; i < MAX_WRONG_UNLOCKS; i++) {
      expect((await unlockLink(db, b.linkId, `wrong${i}`, '203.0.113.9', verify, now)).status).toBe(403)
    }
    const limited = await unlockLink(db, b.linkId, 'secret', '203.0.113.9', verify, now)
    expect(limited).toEqual({ status: 429, body: { error: 'Too many wrong passwords. Wait 10 minutes and try again.' } })
    // Per link id and per address.
    expect((await unlockLink(db, b.linkId, 'secret', '198.51.100.7', verify, now)).status).toBe(200)
    expect((await unlockLink(db, other.linkId, 'other', '203.0.113.9', verify, now)).status).toBe(200)
    // Ten minutes later the address may try again.
    expect((await unlockLink(db, b.linkId, 'secret', '203.0.113.9', verify, now + UNLOCK_WINDOW_MS + 1)).status).toBe(200)
  })

  it('an unknown, private or trashed link is 404; a link without a password needs no unlock', async () => {
    const ada = user('Ada')
    const priv = board(ada.userId, { visibility: 'private', passwordHash: 'h:x' })
    const trashed = board(ada.userId, { passwordHash: 'h:x', trashedAt: Date.now() })
    const open = board(ada.userId)
    for (const key of ['nope', priv.linkId, trashed.linkId, priv.id]) {
      expect(await unlockLink(db, key, 'x', '203.0.113.9', verify), key).toEqual({ status: 404, body: { error: 'not found' } })
    }
    expect(await unlockLink(db, open.linkId, 'x', '203.0.113.9', verify)).toEqual({ status: 200, body: { ok: true }, unlock: false })
  })

  it('the unlocked list keeps the newest 50, without repeats', () => {
    let list: string[] = []
    for (let i = 0; i < MAX_UNLOCKED + 5; i++) list = withUnlocked(list, `l${i}`)
    expect(list).toHaveLength(MAX_UNLOCKED)
    expect(list[0]).toBe('l5')
    expect(list.at(-1)).toBe(`l${MAX_UNLOCKED + 4}`)
    expect(withUnlocked(['a', 'b'], 'a')).toEqual(['b', 'a'])
    expect(withUnlocked(undefined, 'a')).toEqual(['a'])
    expect(withUnlocked(['a', 3, null], 'b')).toEqual(['a', 'b'])
  })
})
