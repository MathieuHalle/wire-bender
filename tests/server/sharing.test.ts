import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BoardFile } from '../../core/schema'
import { openDb, type Db } from '../../server/db'
import { boards, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { access, resetUnlocks, unlockLink, withUnlocked } from '../../server/utils/boardAccess'
import { createBoard, getBoardRow } from '../../server/utils/boards'
import { openRoom, type PeerLink } from '../../server/utils/rooms'
import { PREMIUM_NEEDED, getSharing, patchSharing, regenerateLink } from '../../server/utils/sharing'
import type { Who } from '../../server/utils/who'

let dir: string
let db: Db
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')) as BoardFile
const BASE = 'https://wire.example.org'

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-sharing-'))
  db = openDb(dir)
  resetUnlocks()
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

// A stand-in for nuxt-auth-utils' hashPassword / verifyPassword.
const hash = async (plain: string) => `h:${plain}`
const verify = async (h: string, plain: string) => h === `h:${plain}`
const deps = { base: BASE, hash }

function user(name: string, isPremium = false): Who & { kind: 'user' } {
  const r = signIn(db, 'github', { id: `gh-${name}`, name })
  if (!r.ok) throw new Error('sign-in failed')
  db.update(users).set({ isPremium: isPremium ? 1 : 0 }).where(eq(users.id, r.userId)).run()
  return { kind: 'user', userId: r.userId, author: name, isAdmin: false, isPremium }
}

function board(ownerId: string, set: Partial<typeof boards.$inferInsert> = {}): { id: string, linkId: string } {
  const { id } = createBoard(db, fixture, 'import', 'x', ownerId)
  if (Object.keys(set).length > 0) db.update(boards).set(set).where(eq(boards.id, id)).run()
  return { id, linkId: getBoardRow(db, id)!.linkId }
}

const patch = (who: Who, key: string, body: unknown) => patchSharing(db, { key, who }, JSON.stringify(body), deps)

/** A peer in the board's live room, recording how it was closed. */
function joinPeer(boardId: string, peerId: string, viaLink: boolean, role: 'owner' | 'edit' | 'view' = 'edit') {
  const closed: { code: number, reason: string }[] = []
  const link: PeerLink = { update: () => {}, awareness: () => {}, close: (code, reason) => closed.push({ code, reason }) }
  openRoom(db, boardId)!.join(peerId, peerId, link, { role, viaLink })
  return closed
}

describe('GET sharing', () => {
  it('the owner sees the settings and the link, never the hash', async () => {
    const ada = user('Ada')
    const b = board(ada.userId, { passwordHash: 'h:secret' })
    const r = getSharing(db, { key: b.id, who: ada }, BASE)
    expect(r).toEqual({ status: 200, body: { visibility: 'view', hasPassword: true, link: `${BASE}/b/${b.linkId}`, canUsePremium: false } })
    expect(JSON.stringify(r.body)).not.toContain('h:secret')
    expect(getSharing(db, { key: b.id, who: ada }, `${BASE}/`).body).toMatchObject({ link: `${BASE}/b/${b.linkId}` })
    expect(getSharing(db, { key: board(user('Pam', true).userId).id, who: { ...user('Pam', true) } }, BASE).body).toMatchObject({ canUsePremium: true })
  })

  it('local mode offers no sharing', () => {
    const b = board('local')
    expect(getSharing(db, { key: b.id, who: { kind: 'local', userId: 'local', author: 'Local' } }, null).status).toBe(404)
  })
})

describe('non-owner can\'t read or change sharing', () => {
  it('is the same 404 as an unknown board', async () => {
    const ada = user('Ada')
    const bob = user('Bob', true)
    const b = board(ada.userId, { visibility: 'edit' })
    const unknown = getSharing(db, { key: 'no-such-board', who: bob }, BASE)
    expect(unknown).toEqual({ status: 404, body: { error: 'not found' } })
    for (const key of [b.id, b.linkId]) {
      for (const who of [bob, { kind: 'anonymous' } as Who]) {
        expect(getSharing(db, { key, who }, BASE)).toEqual(unknown)
        expect(await patch(who, key, { visibility: 'view' })).toEqual(unknown)
        expect(regenerateLink(db, { key, who }, BASE)).toEqual(unknown)
      }
    }
    // Even the owner, by the link: only the board id is the owner's.
    expect(getSharing(db, { key: b.linkId, who: ada }, BASE)).toEqual(unknown)
    expect(getBoardRow(db, b.id)).toMatchObject({ visibility: 'edit', linkId: b.linkId })
  })
})

describe('PATCH sharing', () => {
  it('premium rules hold on the API', async () => {
    const free = user('Ada')
    const b = board(free.userId)
    // Free: view and edit only, no password.
    expect(await patch(free, b.id, { visibility: 'edit' })).toMatchObject({ status: 200, body: { visibility: 'edit', hasPassword: false } })
    expect(await patch(free, b.id, { visibility: 'private' })).toEqual({ status: 403, body: { error: PREMIUM_NEEDED } })
    expect(await patch(free, b.id, { password: 'secret' })).toEqual({ status: 403, body: { error: PREMIUM_NEEDED } })
    expect(PREMIUM_NEEDED).toBe('Premium is needed for private boards and link passwords.')
    expect(getBoardRow(db, b.id)).toMatchObject({ visibility: 'edit', passwordHash: null })

    // Premium: both work.
    db.update(users).set({ isPremium: 1 }).where(eq(users.id, free.userId)).run()
    const premium = { ...free, isPremium: true }
    expect(await patch(premium, b.id, { visibility: 'private', password: 'secret' })).toMatchObject({ status: 200, body: { visibility: 'private', hasPassword: true } })
    expect(getBoardRow(db, b.id)!.passwordHash).toBe('h:secret')

    // Premium lost: what exists stays; a new password is refused; lowering and removal work.
    db.update(users).set({ isPremium: 0 }).where(eq(users.id, free.userId)).run()
    const lapsed = { ...free, isPremium: false }
    expect(getSharing(db, { key: b.id, who: lapsed }, BASE).body).toMatchObject({ visibility: 'private', hasPassword: true, canUsePremium: false })
    expect(await patch(lapsed, b.id, { visibility: 'private' })).toMatchObject({ status: 200, body: { visibility: 'private' } })
    expect(await patch(lapsed, b.id, { password: 'another' })).toEqual({ status: 403, body: { error: PREMIUM_NEEDED } })
    expect(getBoardRow(db, b.id)!.passwordHash).toBe('h:secret')
    expect(await patch(lapsed, b.id, { password: null })).toMatchObject({ status: 200, body: { hasPassword: false } })
    expect(await patch(lapsed, b.id, { visibility: 'view' })).toMatchObject({ status: 200, body: { visibility: 'view' } })
    expect(await patch(lapsed, b.id, { visibility: 'private' })).toEqual({ status: 403, body: { error: PREMIUM_NEEDED } })
    expect(getBoardRow(db, b.id)).toMatchObject({ visibility: 'view', passwordHash: null })
  })

  it('checks the body', async () => {
    const pam = user('Pam', true)
    const b = board(pam.userId)
    expect((await patch(pam, b.id, { visibility: 'public' })).status).toBe(422)
    expect((await patch(pam, b.id, { password: 'abc' })).status).toBe(422)
    expect((await patch(pam, b.id, { password: 'x'.repeat(101) })).status).toBe(422)
    expect((await patch(pam, b.id, { password: 42 })).status).toBe(422)
    expect((await patchSharing(db, { key: b.id, who: pam }, 'not json', deps)).status).toBe(422)
    expect((await patchSharing(db, { key: b.id, who: pam }, '[]', deps)).status).toBe(422)
    // Lengths count code points: four emoji are four characters.
    expect((await patch(pam, b.id, { password: '🔌🔌🔌🔌' })).status).toBe(200)
    expect((await patch(pam, b.id, { password: 'x'.repeat(100) })).status).toBe(200)
    expect(getBoardRow(db, b.id)).toMatchObject({ visibility: 'view', passwordHash: `h:${'x'.repeat(100)}` })
  })

  it('lowering edit to view closes link peers', async () => {
    const ada = user('Ada')
    const b = board(ada.userId, { visibility: 'edit' })
    const visitor = joinPeer(b.id, 'visitor', true)
    const owner = joinPeer(b.id, 'owner', false, 'owner')
    expect((await patch(ada, b.id, { visibility: 'view' })).status).toBe(200)
    expect(visitor).toEqual([{ code: 4403, reason: 'access changed' }])
    expect(owner).toEqual([])
    const room = openRoom(db, b.id)!
    expect(room.peerAccess('visitor')).toBeNull()
    expect(room.peerAccess('owner')).toEqual({ role: 'owner', viaLink: false })
    // A message from the kicked peer is refused, even before its socket is gone.
    expect(room.receive('visitor', 'visitor', new Uint8Array([0, 0]))).toMatchObject({ ok: false })
    room.leave('owner')
  })

  it('changing the password voids old unlocks and closes link peers', async () => {
    const pam = user('Pam', true)
    const b = board(pam.userId)
    await patch(pam, b.id, { password: 'secret' })
    const r = await unlockLink(db, b.linkId, 'secret', '203.0.113.9', verify)
    if (r.status !== 200 || !r.entry) throw new Error('unlock failed')
    // The entry names the link but never holds the hash.
    expect(r.entry.startsWith(b.linkId)).toBe(true)
    expect(r.entry).not.toContain('secret')
    const unlocked = withUnlocked([], r.entry)
    const bob = user('Bob')
    expect(access(db, bob, b.linkId, unlocked)).toMatchObject({ ok: true, viaLink: true })
    // The bare link id, as a step-1 session might hold it, is no unlock.
    expect(access(db, bob, b.linkId, [b.linkId])).toEqual({ ok: false, status: 401 })

    const peer = joinPeer(b.id, 'visitor', true, 'view')
    expect((await patch(pam, b.id, { password: 'changed' })).status).toBe(200)
    expect(peer).toEqual([{ code: 4403, reason: 'access changed' }])
    expect(access(db, bob, b.linkId, unlocked)).toEqual({ ok: false, status: 401 })

    // Unlocked again with the new password: the new entry replaces the link's old one.
    // Without a password the link needs no unlock at all.
    const again = await unlockLink(db, b.linkId, 'changed', '203.0.113.9', verify)
    if (again.status !== 200 || !again.entry) throw new Error('unlock failed')
    const list = withUnlocked(unlocked, again.entry)
    expect(list).toEqual([again.entry])
    expect(access(db, bob, b.linkId, list)).toMatchObject({ ok: true })
    expect((await patch(pam, b.id, { password: null })).status).toBe(200)
    expect(access(db, bob, b.linkId, [])).toMatchObject({ ok: true })
  })
})

describe('POST sharing/regenerate', () => {
  it('regenerating the link closes link peers with 4403', async () => {
    const ada = user('Ada')
    const b = board(ada.userId, { visibility: 'edit' })
    const visitor = joinPeer(b.id, 'visitor', true)
    const owner = joinPeer(b.id, 'owner', false, 'owner')
    const r = regenerateLink(db, { key: b.id, who: ada }, BASE)
    const linkId = getBoardRow(db, b.id)!.linkId
    expect(linkId).not.toBe(b.linkId)
    expect(r).toEqual({ status: 200, body: { link: `${BASE}/b/${linkId}` } })
    expect(visitor).toEqual([{ code: 4403, reason: 'access changed' }])
    expect(owner).toEqual([])
    // The old link is the same 404 as an unknown one; the new one opens.
    expect(access(db, user('Bob'), b.linkId, [])).toEqual({ ok: false, status: 404 })
    expect(access(db, user('Bob'), linkId, [])).toMatchObject({ ok: true, role: 'edit' })
    openRoom(db, b.id)!.leave('owner')
  })

  it('a password unlock does not carry over to the new link', async () => {
    const pam = user('Pam', true)
    const b = board(pam.userId)
    await patch(pam, b.id, { password: 'secret' })
    const r = await unlockLink(db, b.linkId, 'secret', '203.0.113.9', verify)
    if (r.status !== 200 || !r.entry) throw new Error('unlock failed')
    regenerateLink(db, { key: b.id, who: pam }, BASE)
    const linkId = getBoardRow(db, b.id)!.linkId
    expect(access(db, user('Bob'), linkId, [r.entry])).toEqual({ ok: false, status: 401 })
  })
})
