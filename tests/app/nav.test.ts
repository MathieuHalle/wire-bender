import { describe, expect, it } from 'vitest'
import type { Me } from '../../app/composables/useMe'
import { SIGN_IN_ERRORS, boardLists, homeTarget, needsLogin, settingsTabs, signInError } from '../../app/utils/nav'

const local: Me = { mode: 'local', user: null, providers: [] }
const anon: Me = { mode: 'public', user: null, providers: ['github'] }
const ada: Me = { mode: 'public', providers: ['github'], user: { id: 'u1', name: 'Ada', avatar: null, isAdmin: false, isPremium: false, providers: ['github'], deletedAt: null } }
const admin: Me = { ...ada, user: { ...ada.user!, isAdmin: true } }

describe('navigation rules', () => {
  it('lists boards per mode', () => {
    expect(boardLists(local)).toEqual(['mine', 'trash'])
    expect(boardLists(ada)).toEqual(['mine', 'shared', 'trash'])
  })

  it('lists settings tabs per mode and role', () => {
    expect(settingsTabs(local)).toEqual(['account', 'devices', 'connections'])
    expect(settingsTabs(ada)).toEqual(['account', 'connections'])
    expect(settingsTabs(admin)).toEqual(['account', 'connections', 'admin'])
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

  it('words sign-in errors', () => {
    expect(signInError(null)).toBeNull()
    expect(signInError('suspended')).toBe(SIGN_IN_ERRORS.suspended)
    expect(signInError('nonsense')).toBe(SIGN_IN_ERRORS.oauth)
  })
})
