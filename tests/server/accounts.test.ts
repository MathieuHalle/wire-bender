import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../server/db'
import { identities, users } from '../../server/db/schema'
import { cleanName, me, meBody, providersOf, rename, signIn } from '../../server/utils/accounts'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-accounts-'))
  db = openDb(dir)
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function userId(r: ReturnType<typeof signIn>): string {
  if (!r.ok) throw new Error(`sign-in failed: ${r.reason}`)
  return r.userId
}

const userCount = () => db.select().from(users).all().length

describe('signIn', () => {
  it('a known identity gives its user', () => {
    const id = userId(signIn(db, 'github', { id: '42', name: 'Ada', avatar: 'https://a.example/ada.png' }))
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(signIn(db, 'github', { id: '42', name: 'Someone else now' })).toEqual({ ok: true, userId: id })
    const row = db.select().from(users).where(eq(users.id, id)).get()!
    expect(row).toMatchObject({ name: 'Ada', avatar: 'https://a.example/ada.png', isAdmin: 0, isPremium: 0, suspendedAt: null, deletedAt: null })
  })

  it('a new identity while signed out is a new account', () => {
    const before = userCount()
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    // The same person (same name, maybe the same email) with Google, signed out: a second account, never joined.
    const b = userId(signIn(db, 'google', { id: 'g-42', name: 'Ada' }))
    expect(b).not.toBe(a)
    expect(userCount()).toBe(before + 2)
    expect(providersOf(db, a)).toEqual(['github'])
    expect(providersOf(db, b)).toEqual(['google'])
  })

  it('linking while signed in joins the identity', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    const before = userCount()
    expect(signIn(db, 'google', { id: 'g-42', name: 'Ada G' }, a)).toEqual({ ok: true, userId: a })
    expect(userCount()).toBe(before)
    expect(providersOf(db, a)).toEqual(['github', 'google'])
    // Signing in with either one now gives the same account.
    expect(signIn(db, 'google', { id: 'g-42', name: 'Ada G' })).toEqual({ ok: true, userId: a })
    // Linking what is already linked to you is fine.
    expect(signIn(db, 'github', { id: '42', name: 'Ada' }, a)).toEqual({ ok: true, userId: a })
  })

  it('an identity of another account can\'t be linked', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    const b = userId(signIn(db, 'google', { id: 'g-7', name: 'Bob' }))
    expect(signIn(db, 'google', { id: 'g-7', name: 'Bob' }, a)).toEqual({ ok: false, reason: 'taken' })
    expect(providersOf(db, a)).toEqual(['github'])
    expect(db.select().from(identities).where(eq(identities.providerId, 'g-7')).get()!.userId).toBe(b)
  })

  it('a deleted (not purged) user signs in for a restore (R1)', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    db.update(users).set({ deletedAt: Date.now() }).where(eq(users.id, a)).run()
    expect(signIn(db, 'github', { id: '42', name: 'Ada' })).toEqual({ ok: true, userId: a, deleted: true })
  })

  it('an identity whose user is gone signs in as no one, and says so (gone)', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    db.$client.pragma('foreign_keys = OFF')
    db.delete(users).where(eq(users.id, a)).run()
    const before = userCount()
    expect(signIn(db, 'github', { id: '42', name: 'Ada' })).toEqual({ ok: false, reason: 'gone' })
    expect(userCount()).toBe(before)
  })

  it('linking from a session whose user is gone says so (gone)', () => {
    expect(signIn(db, 'github', { id: '42', name: 'Ada' }, 'no-such-user')).toEqual({ ok: false, reason: 'gone' })
  })

  it('a suspended user can\'t link either', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    db.update(users).set({ suspendedAt: Date.now() }).where(eq(users.id, a)).run()
    expect(signIn(db, 'google', { id: 'g-42', name: 'Ada' }, a)).toEqual({ ok: false, reason: 'suspended' })
    expect(providersOf(db, a)).toEqual(['github'])
  })

  it('a provider name is cleaned; an empty one gets a placeholder', () => {
    const a = userId(signIn(db, 'github', { id: '1', name: '  A​da\u0007  ' }))
    expect(me(db, a)?.name).toBe('Ada')
    const b = userId(signIn(db, 'github', { id: '2', name: '‮' }))
    expect(me(db, b)?.name).toBe('New user')
    const c = userId(signIn(db, 'github', { id: '3', name: 'x'.repeat(80) }))
    expect(me(db, c)?.name).toBe('x'.repeat(60))
  })
})

describe('names', () => {
  it('cleanName strips control and format characters, 1 to 60 chars', () => {
    expect(cleanName(' Ada‍ Lovelace ')).toBe('Ada Lovelace')
    expect(cleanName('\u0000​')).toBeNull()
    expect(cleanName('x'.repeat(60))).toBe('x'.repeat(60))
    expect(cleanName('x'.repeat(61))).toBeNull()
    expect(cleanName(42)).toBeNull()
  })

  it('line and paragraph separators and lone surrogates are stripped too', () => {
    expect(cleanName('Ada\u2028Love\u2029lace')).toBe('AdaLovelace')
    expect(cleanName('A\uD800da\uDC00')).toBe('Ada')
    expect(cleanName('\u2028\uD800')).toBeNull()
  })

  it('1 to 60 counts code points, the same for PATCH and provider names', () => {
    const emoji = '\u{1F50C}'
    expect(cleanName(emoji.repeat(60))).toBe(emoji.repeat(60))
    expect(cleanName(emoji.repeat(61))).toBeNull()
    const r = signIn(db, 'github', { id: 'e', name: emoji.repeat(70) })
    if (!r.ok) throw new Error('sign-in failed')
    const stored = me(db, r.userId)!.name
    expect(stored).toBe(emoji.repeat(60))
    // What a provider gives can always be saved back unchanged.
    expect(cleanName(stored)).toBe(stored)
  })

  it('rename sets the name', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    expect(rename(db, a, 'Ada L.')).toBe(true)
    expect(me(db, a)).toEqual({ id: a, name: 'Ada L.', avatar: null, isAdmin: false, isPremium: false, providers: ['github'], deletedAt: null, isOnlyAdmin: false })
    expect(rename(db, a, '​')).toBe(false)
    expect(me(db, a)?.name).toBe('Ada L.')
  })
})

describe('GET /api/me body', () => {
  const anonymous = { who: { kind: 'anonymous' as const }, account: null, pendingDeletion: false }

  it('local mode: the local user, nothing to sign in with', () => {
    const local = { who: { kind: 'local' as const, userId: 'local' as const, author: 'Local · This computer' }, account: null, pendingDeletion: false }
    expect(meBody(db, 'local', local, ['github'])).toEqual({
      mode: 'local',
      user: { id: 'local', name: 'Local', avatar: null, isAdmin: true, isPremium: true, providers: [], deletedAt: null, isOnlyAdmin: false },
      providers: []
    })
  })

  it('public mode: the signed-in user, or null, and the configured providers', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    const signedIn = { who: { kind: 'user' as const, userId: a, author: 'Ada', isAdmin: false, isPremium: false }, account: null, pendingDeletion: false }
    expect(meBody(db, 'public', signedIn, ['github', 'google'])).toMatchObject({ mode: 'public', user: { id: a, name: 'Ada', providers: ['github'] }, providers: ['github', 'google'] })
    expect(meBody(db, 'public', anonymous, ['google'])).toEqual({ mode: 'public', user: null, providers: ['google'] })
  })

  it('isOnlyAdmin is true for the one active admin only (R13)', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    const b = userId(signIn(db, 'github', { id: '7', name: 'Bob' }))
    db.update(users).set({ isAdmin: 1 }).where(eq(users.id, a)).run()
    expect(me(db, a)?.isOnlyAdmin).toBe(true)
    expect(me(db, b)?.isOnlyAdmin).toBe(false)
    db.update(users).set({ isAdmin: 1 }).where(eq(users.id, b)).run()
    expect(me(db, a)?.isOnlyAdmin).toBe(false)
  })

  it('a pendingDeletion session sees its user with deletedAt (R1)', () => {
    const a = userId(signIn(db, 'github', { id: '42', name: 'Ada' }))
    db.update(users).set({ deletedAt: 1234 }).where(eq(users.id, a)).run()
    const row = db.select().from(users).where(eq(users.id, a)).get()!
    expect(meBody(db, 'public', { who: { kind: 'anonymous' }, account: row, pendingDeletion: true }, ['github']).user).toMatchObject({ id: a, deletedAt: 1234 })
  })
})
