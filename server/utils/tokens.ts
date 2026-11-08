// Personal API tokens (step 3). A token is `wb_` plus 32 random bytes as base64url, shown
// once at creation. Only its sha256 is stored, with a display prefix. Authenticating with
// one is Task 2; this is storage and management.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, count, desc, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { tokens } from '../db/schema'
import { MAX_NAME, cleanName } from './accounts'

export type TokenRow = typeof tokens.$inferSelect

export const MAX_TOKENS = 20
export const TOKEN_TOUCH_MS = 60_000
export const TOKEN_LIMIT = `Token limit reached (${MAX_TOKENS}). Revoke one first.`

const TOKEN_FORMAT = /^wb_[A-Za-z0-9_-]{43}$/

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export type MintResult
  = { ok: true, token: string, row: TokenRow }
    | { ok: false, status: 409 | 422, body: { error: string } | { errors: string[] } }

/** Make a token for `userId`. The token string is in the result only; it is not stored. */
export function mintToken(db: Db, userId: string, name: unknown, now = Date.now()): MintResult {
  const clean = cleanName(name)
  if (clean === null) return { ok: false, status: 422, body: { errors: [`name: must be 1 to ${MAX_NAME} characters`] } }
  const token = `wb_${randomBytes(32).toString('base64url')}`
  const row: TokenRow = {
    id: randomUUID(), userId, name: clean, hash: hashToken(token), prefix: token.slice(3, 11), createdAt: now, lastUsedAt: null
  }
  // Check and insert in one transaction, so two requests cannot both take the last slot.
  const full = db.transaction((tx) => {
    const n = tx.select({ n: count() }).from(tokens).where(eq(tokens.userId, userId)).get()?.n ?? 0
    if (n >= MAX_TOKENS) return true
    tx.insert(tokens).values(row).run()
    return false
  })
  if (full) return { ok: false, status: 409, body: { error: TOKEN_LIMIT } }
  return { ok: true, token, row }
}

/** The row for a bearer string, or null if it is malformed or unknown. The lookup is by hash, so no secret is compared byte by byte. */
export function tokenByBearer(db: Db, bearer: string): TokenRow | null {
  if (!TOKEN_FORMAT.test(bearer)) return null
  return db.select().from(tokens).where(eq(tokens.hash, hashToken(bearer))).get() ?? null
}

export interface TokenListing { id: string, name: string, prefix: string, createdAt: number, lastUsedAt: number | null }

/** A user's tokens, newest first. Never the hash. */
export function listTokens(db: Db, userId: string): TokenListing[] {
  return db.select({ id: tokens.id, name: tokens.name, prefix: tokens.prefix, createdAt: tokens.createdAt, lastUsedAt: tokens.lastUsedAt })
    .from(tokens).where(eq(tokens.userId, userId)).orderBy(desc(tokens.createdAt), desc(tokens.id)).all()
}

/** Delete one of the user's own tokens; false if it is not theirs or is gone. */
export function revokeToken(db: Db, userId: string, id: string): boolean {
  return db.delete(tokens).where(and(eq(tokens.id, id), eq(tokens.userId, userId))).run().changes === 1
}

/** Record a use, at most once per TOKEN_TOUCH_MS per token. */
export function touchToken(db: Db, row: Pick<TokenRow, 'id' | 'lastUsedAt'>, now = Date.now()): void {
  if (row.lastUsedAt !== null && now - row.lastUsedAt < TOKEN_TOUCH_MS) return
  db.update(tokens).set({ lastUsedAt: now }).where(eq(tokens.id, row.id)).run()
}
