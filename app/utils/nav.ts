// Navigation rules for the dashboard: which board lists and settings tabs each mode shows,
// where `/` sends you, and the wording of sign-in errors. Pure: no Vue.
import type { Me } from '../composables/useMe'

export type BoardList = 'mine' | 'shared' | 'trash'
export type SettingsTab = 'account' | 'devices' | 'connections' | 'admin'

/** The board lists this mode shows: "shared with me" only exists with accounts. */
export function boardLists(me: Me): BoardList[] {
  return me.mode === 'local' ? ['mine', 'trash'] : ['mine', 'shared', 'trash']
}

/** The settings tabs this mode and user see, in display order. */
export function settingsTabs(me: Me): SettingsTab[] {
  const tabs: SettingsTab[] = me.mode === 'local' ? ['account', 'devices', 'connections'] : ['account', 'connections']
  if (me.user?.isAdmin) tabs.push('admin')
  return tabs
}

/** Public mode with nobody signed in: the dashboard pages need a sign-in first. */
export function needsLogin(me: Me): boolean {
  return me.mode === 'public' && !me.user
}

/** Where `/` goes: the page to return to, else the boards; null shows the signed-out home page. */
export function homeTarget(me: Me, back: string | null): string | null {
  return needsLogin(me) ? null : (back ?? '/boards')
}

/** What each sign-in error code (`?error=`) says. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  taken: 'That sign-in is already used by another WireBender account, so it was not linked.',
  suspended: 'This account is suspended.',
  deleted: 'This account is deleted.',
  oauth: 'Sign-in did not finish. Try again.'
}

/** The text for an error code; an unknown code reads as a sign-in that did not finish. */
export function signInError(code: string | null): string | null {
  return code ? SIGN_IN_ERRORS[code] ?? SIGN_IN_ERRORS.oauth! : null
}

/** How each board list shows in the sidebar and the search. */
export const BOARD_LIST_LINKS: Record<BoardList, { label: string, to: string, icon: string }> = {
  mine: { label: 'My boards', to: '/boards', icon: 'i-lucide-circuit-board' },
  shared: { label: 'Shared with me', to: '/boards/shared', icon: 'i-lucide-users' },
  trash: { label: 'Trash', to: '/boards/trash', icon: 'i-lucide-trash-2' }
}
