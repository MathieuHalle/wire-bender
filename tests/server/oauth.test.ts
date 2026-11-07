// Where a sign-in ends (server/utils/oauth.ts): the redirect and the session written.
// Nitro's helpers and nuxt-auth-utils's session functions are stubbed.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, useDb } from '../../server/db'
import { users } from '../../server/db/schema'
import { signIn } from '../../server/utils/accounts'
import { failedSignIn, finishSignIn } from '../../server/utils/oauth'
import type { SessionData } from '../../server/utils/who'

let session: SessionData = {}
const replaced = vi.fn()

vi.stubGlobal('sendRedirect', (_event: unknown, location: string, status: number) => ({ redirect: location, status }))
vi.stubGlobal('getUserSession', async () => session)
vi.stubGlobal('clearUserSession', async () => {
  session = {}
})
vi.stubGlobal('replaceUserSession', async (_event: unknown, data: SessionData) => {
  replaced(data)
  session = data
})
vi.stubGlobal('useRuntimeConfig', () => ({ session: { name: 'nuxt-auth-session' } }))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-oauth-'))
  vi.stubEnv('WIREBENDER_DATA', dir)
  vi.stubEnv('WIREBENDER_MODE', 'public')
  vi.stubEnv('WIREBENDER_URL', 'https://wire.example.org')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_ID', 'id')
  vi.stubEnv('NUXT_OAUTH_GITHUB_CLIENT_SECRET', 'secret')
  session = {}
  replaced.mockClear()
})
afterEach(() => {
  closeDb()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

/** The callback request: it carries a session cookie once one exists. */
function callback() {
  const cookie = session.user ? { cookie: 'nuxt-auth-session=Fe26.2**sealed' } : {}
  return { node: { req: { method: 'GET', headers: { host: 'wire.example.org', ...cookie } } }, context: {} } as never
}

function existing(id: string, name = 'Ada'): string {
  const r = signIn(useDb(), 'github', { id, name })
  if (!r.ok) throw new Error('sign-in failed')
  return r.userId
}

describe('finishSignIn', () => {
  it('a signed-out sign-in goes to / with a session holding the id only', async () => {
    expect(await finishSignIn(callback(), 'github', { id: '42', name: 'Ada' })).toEqual({ redirect: '/', status: 302 })
    const row = useDb().select().from(users).all().find(u => u.name === 'Ada')!
    expect(replaced).toHaveBeenCalledWith({ user: { id: row.id } })
  })

  it('signing in keeps the links the visitor unlocked, and nothing else', async () => {
    session = { unlocked: ['link-1', 'link-2'], pendingDeletion: true }
    const callbackWithCookie = { node: { req: { method: 'GET', headers: { host: 'wire.example.org', cookie: 'nuxt-auth-session=Fe26.2**sealed' } } }, context: {} } as never
    expect(await finishSignIn(callbackWithCookie, 'github', { id: '42', name: 'Ada' })).toEqual({ redirect: '/', status: 302 })
    const row = useDb().select().from(users).all().find(u => u.name === 'Ada')!
    expect(replaced).toHaveBeenCalledWith({ user: { id: row.id }, unlocked: ['link-1', 'link-2'] })
  })

  it('a deleted account keeps the unlocked links too (R1)', async () => {
    const a = existing('42')
    useDb().update(users).set({ deletedAt: Date.now() }).where(eq(users.id, a)).run()
    session = { unlocked: ['link-1'] }
    const callbackWithCookie = { node: { req: { method: 'GET', headers: { host: 'wire.example.org', cookie: 'nuxt-auth-session=Fe26.2**sealed' } } }, context: {} } as never
    await finishSignIn(callbackWithCookie, 'github', { id: '42', name: 'Ada' })
    expect(replaced).toHaveBeenCalledWith({ user: { id: a }, pendingDeletion: true, unlocked: ['link-1'] })
  })

  it('linking from a signed-in session goes to / and keeps the session', async () => {
    const a = existing('42')
    session = { user: { id: a } }
    expect(await finishSignIn(callback(), 'google', { id: 'g-42', name: 'Ada' })).toEqual({ redirect: '/', status: 302 })
    expect(replaced).not.toHaveBeenCalled()
  })

  it('another account\'s identity goes to /account?error=taken', async () => {
    const a = existing('42')
    existing('7', 'Bob')
    session = { user: { id: a } }
    expect(await finishSignIn(callback(), 'github', { id: '7', name: 'Bob' })).toEqual({ redirect: '/account?error=taken', status: 302 })
    expect(replaced).not.toHaveBeenCalled()
  })

  it('a suspended account goes to /account?error=suspended', async () => {
    const a = existing('42')
    useDb().update(users).set({ suspendedAt: Date.now() }).where(eq(users.id, a)).run()
    expect(await finishSignIn(callback(), 'github', { id: '42', name: 'Ada' })).toEqual({ redirect: '/account?error=suspended', status: 302 })
    expect(replaced).not.toHaveBeenCalled()
  })

  it('a deleted account goes to /account with a pendingDeletion session (R1)', async () => {
    const a = existing('42')
    useDb().update(users).set({ deletedAt: Date.now() }).where(eq(users.id, a)).run()
    expect(await finishSignIn(callback(), 'github', { id: '42', name: 'Ada' })).toEqual({ redirect: '/account', status: 302 })
    expect(replaced).toHaveBeenCalledWith({ user: { id: a }, pendingDeletion: true })
  })

  it('a failed sign-in goes to /account?error=oauth and logs no data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = { statusCode: 401, data: { access_token: 'gho_secret' } }
    expect(failedSignIn(callback(), 'github', error)).toEqual({ redirect: '/account?error=oauth', status: 302 })
    expect(warn).toHaveBeenCalledWith('[wirebender] GitHub sign-in failed (401)')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('gho_secret')
    warn.mockRestore()
  })
})
