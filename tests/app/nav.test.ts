import { describe, expect, it } from 'vitest'
import type { Me } from '../../app/composables/useMe'
import { SIGN_IN_ERRORS, boardLists, homeStep, homeTarget, listFailureTarget, menuUser, needsLogin, pendingDeletionTarget, settingsTabs, signInError } from '../../app/utils/nav'

const local: Me = { mode: 'local', user: null, providers: [] }
const anon: Me = { mode: 'public', user: null, providers: ['github'] }
const ada: Me = { mode: 'public', providers: ['github'], user: { id: 'u1', name: 'Ada', avatar: null, isAdmin: false, isPremium: false, providers: ['github'], deletedAt: null, isOnlyAdmin: false } }
const admin: Me = { ...ada, user: { ...ada.user!, isAdmin: true } }

describe('navigation rules', () => {
  it('shows the account menu user only in public mode', () => {
    // The real local /api/me has the seeded admin `Local` user, not null.
    const localUser = { ...local, user: { ...ada.user!, name: 'Local', isAdmin: true } }
    expect(menuUser(localUser)).toBeNull()
    expect(menuUser(ada)).toBe(ada.user)
    expect(menuUser(anon)).toBeNull()
  })

  it('lists boards per mode', () => {
    expect(boardLists(local)).toEqual(['mine', 'trash'])
    expect(boardLists(ada)).toEqual(['mine', 'shared', 'trash'])
  })

  it('lists settings tabs per mode and role', () => {
    expect(settingsTabs(local)).toEqual(['account', 'devices', 'connections'])
    expect(settingsTabs(ada)).toEqual(['account', 'connections'])
    expect(settingsTabs(admin)).toEqual(['account', 'connections', 'admin'])
    // The local user is an admin, but local mode has no Server Admin tab.
    expect(settingsTabs({ ...local, user: { ...ada.user!, isAdmin: true } })).toEqual(['account', 'devices', 'connections'])
  })

  it('needs a login in public mode without a user only', () => {
    expect(needsLogin(anon)).toBe(true)
    expect(needsLogin(local)).toBe(false)
    expect(needsLogin(ada)).toBe(false)
  })

  it('sends / to the boards, the return path, or the signed-out home', () => {
    expect(homeTarget(anon, null)).toBeNull()
    expect(homeTarget(ada, null)).toBe('/boards')
    expect(homeTarget(local, null)).toBe('/boards')
    expect(homeTarget(ada, '/settings/connections')).toBe('/settings/connections')
    expect(homeTarget(anon, '/b/abc')).toBeNull()
  })

  it('/ uses up the return path once signed in, and keeps it while signed out', () => {
    expect(homeStep(ada, '/b/abc')).toEqual({ to: '/b/abc', clearStored: true })
    expect(homeStep(local, '/settings/devices')).toEqual({ to: '/settings/devices', clearStored: true })
    expect(homeStep(ada, null)).toEqual({ to: '/boards', clearStored: true })
    // Signed out: the intro, and the path stays for the sign-in that follows.
    expect(homeStep(anon, '/b/abc')).toEqual({ to: null, clearStored: false })
  })

  it('a board list 401 goes to /login only when nobody is signed in any more', async () => {
    const reload = (now: Me | null) => async () => now
    // Signed out in another tab.
    expect(await listFailureTarget(401, ada, reload(anon))).toBe('/login')
    // Still signed in, or /api/me unreachable: the list shows its error.
    expect(await listFailureTarget(401, ada, reload(ada))).toBeNull()
    expect(await listFailureTarget(401, ada, reload(null))).toBeNull()
    // Not a 401, or local mode: no reload at all.
    let reloaded = false
    const spy = async () => {
      reloaded = true
      return anon
    }
    expect(await listFailureTarget(500, ada, spy)).toBeNull()
    expect(await listFailureTarget(401, local, spy)).toBeNull()
    expect(reloaded).toBe(false)
  })

  it('a deleted account\'s session only follows links to /account/deleted and /logout (R1)', () => {
    const deleted: Me = { ...ada, user: { ...ada.user!, deletedAt: 1234 } }
    expect(pendingDeletionTarget(deleted, '/boards')).toBe('/account/deleted')
    expect(pendingDeletionTarget(deleted, '/settings/account')).toBe('/account/deleted')
    expect(pendingDeletionTarget(deleted, '/account/deleted')).toBeNull()
    expect(pendingDeletionTarget(deleted, '/logout')).toBeNull()
    expect(pendingDeletionTarget(ada, '/boards')).toBeNull()
    expect(pendingDeletionTarget(null, '/boards')).toBeNull()
  })

  it('words sign-in errors', () => {
    expect(signInError(null)).toBeNull()
    expect(signInError('suspended')).toBe(SIGN_IN_ERRORS.suspended)
    expect(signInError('nonsense')).toBe(SIGN_IN_ERRORS.oauth)
    expect(signInError('gone')).toBe(SIGN_IN_ERRORS.gone)
  })
})
