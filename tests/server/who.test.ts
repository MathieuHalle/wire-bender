import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, type Db } from '../../server/db'
import { users } from '../../server/db/schema'
import { refusal } from '../../server/utils/access'
import type { NodeReqLike } from '../../server/utils/peerAddress'
import { signIn } from '../../server/utils/accounts'
import { checkMode, configuredProviders, MODE_ERRORS, SECRET_ERROR, secretProblem, sessionSecret } from '../../server/utils/mode'
import { resolveSession, whoIs, type SessionData } from '../../server/utils/who'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-who-'))
  db = openDb(dir)
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function event(remoteAddress: string | undefined, headers: Record<string, string> = {}, method = 'GET') {
  const req: NodeReqLike = { method, socket: { remoteAddress, localPort: 3002 }, headers }
  return { node: { req } }
}

const GITHUB = { NUXT_OAUTH_GITHUB_CLIENT_ID: 'id', NUXT_OAUTH_GITHUB_CLIENT_SECRET: 'secret' }
const GOOGLE = { NUXT_OAUTH_GOOGLE_CLIENT_ID: 'id', NUXT_OAUTH_GOOGLE_CLIENT_SECRET: 'secret' }
const URL_ = { WIREBENDER_URL: 'https://wire.example.org' }

describe('checkMode', () => {
  it('local passes; anything but local or public stops with the exact message', () => {
    expect(checkMode({ WIREBENDER_MODE: 'local' })).toBe('local')
    for (const env of [{}, { WIREBENDER_MODE: 'foo' }, { WIREBENDER_MODE: 'Public' }]) {
      expect(() => checkMode(env)).toThrow(MODE_ERRORS.mode)
    }
    expect(MODE_ERRORS.mode).toBe('WIREBENDER_MODE must be local or public')
  })

  it('public needs WIREBENDER_URL', () => {
    expect(() => checkMode({ WIREBENDER_MODE: 'public', ...GITHUB })).toThrow(MODE_ERRORS.url)
    expect(() => checkMode({ WIREBENDER_MODE: 'public', WIREBENDER_URL: 'not a url', ...GITHUB })).toThrow(MODE_ERRORS.url)
    expect(MODE_ERRORS.url).toBe('public mode needs WIREBENDER_URL, the address people use to reach this server')
  })

  it('public needs a whole provider pair', () => {
    for (const env of [{}, { NUXT_OAUTH_GITHUB_CLIENT_ID: 'id' }, { NUXT_OAUTH_GOOGLE_CLIENT_SECRET: 's' }]) {
      expect(() => checkMode({ WIREBENDER_MODE: 'public', ...URL_, ...env })).toThrow(MODE_ERRORS.provider)
    }
    expect(MODE_ERRORS.provider).toBe('public mode needs a sign-in provider: set NUXT_OAUTH_GITHUB_CLIENT_ID and NUXT_OAUTH_GITHUB_CLIENT_SECRET, or the Google pair')
    expect(checkMode({ WIREBENDER_MODE: 'public', ...URL_, ...GITHUB })).toBe('public')
    expect(checkMode({ WIREBENDER_MODE: 'public', ...URL_, ...GOOGLE })).toBe('public')
  })

  it('lists the configured providers', () => {
    expect(configuredProviders({})).toEqual([])
    expect(configuredProviders({ ...GOOGLE })).toEqual(['google'])
    expect(configuredProviders({ ...GITHUB, ...GOOGLE })).toEqual(['github', 'google'])
  })
})

/** whoIs with an in-memory session. */
function asker(session: SessionData = {}) {
  const clear = vi.fn(async () => {})
  return { clear, deps: (mode: 'local' | 'public') => ({ mode, db, readSession: async () => session, clearSession: clear }) }
}

describe('whoIs', () => {
  it('local mode: the machine is the local user, a stranger is anonymous', async () => {
    const a = asker()
    expect(await whoIs(event('127.0.0.1'), a.deps('local'))).toEqual({ kind: 'local', userId: 'local', author: 'Local · This computer' })
    expect(await whoIs(event('192.168.1.20'), a.deps('local'))).toEqual({ kind: 'anonymous' })
  })

  it('public mode does not trust loopback', async () => {
    const a = asker()
    for (const address of ['127.0.0.1', '::1']) {
      expect(await whoIs(event(address), a.deps('public'))).toEqual({ kind: 'anonymous' })
    }
  })

  it('public mode: the session user, loaded from the db', async () => {
    const r = signIn(db, 'github', { id: '42', name: 'Ada' })
    if (!r.ok) throw new Error('sign-in failed')
    db.update(users).set({ isPremium: 1 }).where(eq(users.id, r.userId)).run()
    const a = asker({ user: { id: r.userId } })
    expect(await whoIs(event('203.0.113.9'), a.deps('public'))).toEqual({ kind: 'user', userId: r.userId, author: 'Ada', isAdmin: false, isPremium: true })
    // A rename shows at once: nothing but the id is kept in the session.
    db.update(users).set({ name: 'Ada L.' }).where(eq(users.id, r.userId)).run()
    expect(await whoIs(event('203.0.113.9'), a.deps('public'))).toMatchObject({ author: 'Ada L.' })
  })

  it('suspended user is anonymous and can\'t sign in', async () => {
    const r = signIn(db, 'github', { id: '42', name: 'Ada' })
    if (!r.ok) throw new Error('sign-in failed')
    db.update(users).set({ suspendedAt: Date.now() }).where(eq(users.id, r.userId)).run()
    const a = asker({ user: { id: r.userId } })
    expect(await whoIs(event('203.0.113.9'), a.deps('public'))).toEqual({ kind: 'anonymous' })
    expect(a.clear).toHaveBeenCalledOnce()
    expect(signIn(db, 'github', { id: '42', name: 'Ada' })).toEqual({ ok: false, reason: 'suspended' })
  })

  it('an unknown session user is anonymous and the session is cleared', async () => {
    const a = asker({ user: { id: 'gone' } })
    expect(await whoIs(event('203.0.113.9'), a.deps('public'))).toEqual({ kind: 'anonymous' })
    expect(a.clear).toHaveBeenCalledOnce()
  })

  it('a deleted user is anonymous; with pendingDeletion the session is kept for /account (R1)', async () => {
    const r = signIn(db, 'github', { id: '42', name: 'Ada' })
    if (!r.ok) throw new Error('sign-in failed')
    db.update(users).set({ deletedAt: Date.now() }).where(eq(users.id, r.userId)).run()

    const pending = asker({ user: { id: r.userId }, pendingDeletion: true })
    const s = await resolveSession(event('203.0.113.9'), pending.deps('public'))
    expect(s.who).toEqual({ kind: 'anonymous' })
    expect(s.pendingDeletion).toBe(true)
    expect(s.account?.id).toBe(r.userId)
    expect(pending.clear).not.toHaveBeenCalled()

    // Deleted elsewhere while this session was signed in: it is simply signed out.
    const stale = asker({ user: { id: r.userId } })
    expect(await whoIs(event('203.0.113.9'), stale.deps('public'))).toEqual({ kind: 'anonymous' })
    expect(stale.clear).toHaveBeenCalledOnce()
  })
})

describe('sessionSecret', () => {
  it('session secret is created once and reused', () => {
    const first = sessionSecret(dir, {})
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    const file = path.join(dir, 'session-secret')
    expect(readFileSync(file, 'utf8').trim()).toBe(first)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(sessionSecret(dir, {})).toBe(first)
  })

  it('NUXT_SESSION_PASSWORD wins, and writes nothing', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'wirebender-who-'))
    try {
      const password = 'p'.repeat(40)
      expect(sessionSecret(other, { NUXT_SESSION_PASSWORD: password })).toBe(password)
      expect(() => statSync(path.join(other, 'session-secret'))).toThrow()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('public mode refuses to start unless sessions are sealed with the session secret', () => {
    const secret = 'a'.repeat(64)
    expect(secretProblem('public', secret, secret)).toBeNull()
    expect(secretProblem('public', 'generated-by-the-build'.repeat(2), secret)).toBe(SECRET_ERROR)
    expect(secretProblem('public', undefined, secret)).toBe(SECRET_ERROR)
    // Local mode reads no session.
    expect(secretProblem('local', undefined, secret)).toBeNull()
    expect(SECRET_ERROR).toBe('public mode needs NUXT_APP_SECRET set to the session secret when the server starts: NUXT_SESSION_PASSWORD if set, else the contents of <data>/session-secret (pnpm dev sets it itself)')
  })

  it('a short or empty secret file is refused, never overwritten', () => {
    writeFileSync(path.join(dir, 'session-secret'), 'short\n')
    expect(() => sessionSecret(dir, {})).toThrow(/session-secret/)
    expect(readFileSync(path.join(dir, 'session-secret'), 'utf8')).toBe('short\n')
  })
})

describe('refusal in public mode', () => {
  const pub = 'https://wire.example.org'

  it('public refusal compares Host with WIREBENDER_URL', () => {
    expect(refusal(event('203.0.113.9', { host: 'wire.example.org' }), pub)).toBeNull()
    expect(refusal(event('203.0.113.9', { host: 'WIRE.example.org:443' }), pub)).toBeNull()
    // The machine's own names are not the public server's.
    expect(refusal(event('127.0.0.1', { host: 'localhost' }), pub)).toBe(403)
    expect(refusal(event('203.0.113.9', { host: 'evil.example' }), pub)).toBe(403)
    expect(refusal(event('203.0.113.9', { host: 'wire.example.org:8443' }), pub)).toBe(403)
    expect(refusal(event('203.0.113.9', {}), pub)).toBe(403)
    // An explicit port must be the one people use.
    expect(refusal(event('203.0.113.9', { host: 'wire.example.org:8443' }), 'https://wire.example.org:8443')).toBeNull()
    expect(refusal(event('203.0.113.9', { host: 'wire.example.org' }), 'https://wire.example.org:8443')).toBe(403)
  })

  it('a write from another site is still refused', () => {
    expect(refusal(event('203.0.113.9', { host: 'wire.example.org', origin: 'https://wire.example.org' }, 'POST'), pub)).toBeNull()
    expect(refusal(event('203.0.113.9', { host: 'wire.example.org', origin: 'https://evil.example' }, 'POST'), pub)).toBe(403)
  })
})
