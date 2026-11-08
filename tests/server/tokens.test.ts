import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../server/db'
import { tokens, users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { deleteAccount, purge } from '../../server/utils/lifecycle'
import { MAX_TOKENS, listTokens, mintToken, revokeToken, tokenByBearer, touchToken } from '../../server/utils/tokens'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-tokens-'))
  db = openDb(dir)
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function userId(name: string): string {
  const r = signIn(db, 'github', { id: `gh-${name}`, name })
  if (!r.ok) throw new Error('sign-in failed')
  return r.userId
}

function mint(id: string, name = 'cli') {
  const r = mintToken(db, id, name)
  if (!r.ok) throw new Error('mint failed')
  return r
}

describe('tokens', () => {
  it('a minted token matches wb_ + 43 base64url chars and is stored only as its hash', () => {
    const id = userId('ann')
    const r = mint(id)
    expect(r.token).toMatch(/^wb_[A-Za-z0-9_-]{43}$/)
    expect(r.row.prefix).toBe(r.token.slice(3, 11))
    expect(r.row.hash).toBe(createHash('sha256').update(r.token).digest('hex'))
    const raw = db.$client.prepare('select * from tokens').all() as Record<string, unknown>[]
    expect(raw).toHaveLength(1)
    for (const v of Object.values(raw[0]!)) expect(String(v)).not.toContain(r.token)
    expect(tokenByBearer(db, r.token)?.id).toBe(r.row.id)
    expect(tokenByBearer(db, 'wb_nope')).toBeNull()
    expect(tokenByBearer(db, 'x'.repeat(46))).toBeNull()
    expect(JSON.stringify(listTokens(db, id))).not.toContain(r.token)
    expect(listTokens(db, id)[0]).not.toHaveProperty('hash')
  })

  it('the 21st token is refused with the limit message', () => {
    const id = userId('ann')
    for (let i = 0; i < MAX_TOKENS; i++) mint(id, `t${i}`)
    const r = mintToken(db, id, 'one more')
    expect(r).toEqual({ ok: false, status: 409, body: { error: 'Token limit reached (20). Revoke one first.' } })
    expect(mint(userId('bob')).row.userId).not.toBe(id)
  })

  it('names are cleaned and 1–60 code points', () => {
    const id = userId('ann')
    expect(mint(id, '  a​b\n ').row.name).toBe('ab')
    expect(mint(id, '😀'.repeat(60)).row.name).toBe('😀'.repeat(60))
    for (const bad of ['', '   ', '​', 'x'.repeat(61), '😀'.repeat(61), 5, null, undefined]) {
      expect(mintToken(db, id, bad)).toMatchObject({ ok: false, status: 422 })
    }
  })

  it('revoke deletes only your own token', () => {
    const a = userId('ann')
    const b = userId('bob')
    const t = mint(a)
    expect(revokeToken(db, b, t.row.id)).toBe(false)
    expect(tokenByBearer(db, t.token)).not.toBeNull()
    expect(revokeToken(db, a, t.row.id)).toBe(true)
    expect(tokenByBearer(db, t.token)).toBeNull()
    expect(revokeToken(db, a, t.row.id)).toBe(false)
  })

  it('lists newest first', () => {
    const id = userId('ann')
    const first = mint(id, 'first')
    const second = mint(id, 'second')
    db.update(tokens).set({ createdAt: 1 }).where(eq(tokens.id, first.row.id)).run()
    db.update(tokens).set({ createdAt: 2 }).where(eq(tokens.id, second.row.id)).run()
    expect(listTokens(db, id).map(t => t.name)).toEqual(['second', 'first'])
  })

  it('purge removes a purged user\'s tokens', () => {
    const a = userId('ann')
    const b = userId('bob')
    mint(a)
    mint(b)
    const now = Date.now()
    deleteAccount(db, a, now - 31 * 24 * 3600_000)
    purge(db, now)
    expect(listTokens(db, a)).toEqual([])
    expect(listTokens(db, b)).toHaveLength(1)
    expect(db.select().from(users).where(eq(users.id, a)).all()).toEqual([])
  })

  it('last_used_at moves at most once a minute', () => {
    const id = userId('ann')
    const t = mint(id)
    const last = () => listTokens(db, id)[0]!.lastUsedAt
    expect(last()).toBeNull()
    touchToken(db, t.row, 1_000_000)
    expect(last()).toBe(1_000_000)
    touchToken(db, { ...t.row, lastUsedAt: 1_000_000 }, 1_059_999)
    expect(last()).toBe(1_000_000)
    touchToken(db, { ...t.row, lastUsedAt: 1_000_000 }, 1_060_000)
    expect(last()).toBe(1_060_000)
  })
})
