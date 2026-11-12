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
  if (me.mode === 'public' && me.user?.isAdmin) tabs.push('admin')
  return tabs
}

/** Public mode with nobody signed in: the dashboard pages need a sign-in first. */
export function needsLogin(me: Me): boolean {
  return me.mode === 'public' && !me.user
}

/** The user the account menu shows: only public mode has accounts; local mode's `Local` row is not one. */
export function menuUser(me: Me): Me['user'] {
  return me.mode === 'public' ? me.user : null
}

/** Where `/` goes: the page to return to, else the boards; null shows the signed-out home page. */
export function homeTarget(me: Me, back: string | null): string | null {
  return needsLogin(me) ? null : (back ?? '/boards')
}

/**
 * What `/` does with the stored return path (`stored`, already checked by returnPath):
 * signed in (or local mode), it goes there and the path is used up; signed out, it shows the
 * intro and keeps the path, which the sign-in that follows still needs.
 */
export function homeStep(me: Me, stored: string | null): { to: string | null, clearStored: boolean } {
  const signedOut = needsLogin(me)
  return { to: homeTarget(me, signedOut ? null : stored), clearStored: !signedOut }
}

/**
 * A board list request failed with `status`. A 401 in public mode may mean this browser
 * signed out meanwhile (another tab): `reloadMe` reads who we are again, and if nobody is
 * signed in now the list goes to /login. Anything else (or /api/me unreachable, or still
 * signed in) is a real failure: null, and the list shows its error, never "Loading…" for ever.
 */
export async function listFailureTarget(status: number | undefined, me: Me | null, reloadMe: () => Promise<Me | null>): Promise<string | null> {
  if (status !== 401 || me?.mode !== 'public') return null
  const now = await reloadMe()
  return now && needsLogin(now) ? '/login' : null
}

/** Pages a deleted account waiting for its restore (ruling R1) may open. */
const PENDING_DELETION_PAGES = new Set(['/account/deleted', '/logout'])

/** Where a link to `path` must go instead: /account/deleted for a deleted account's session, else null. */
export function pendingDeletionTarget(me: Me | null, path: string): string | null {
  return me?.user?.deletedAt && !PENDING_DELETION_PAGES.has(path) ? '/account/deleted' : null
}

/** What each sign-in error code (`?error=`) says. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  taken: 'That sign-in is already used by another WireBender account, so it was not linked.',
  suspended: 'This account is suspended.',
  deleted: 'This account is deleted.',
  gone: 'The account this sign-in belonged to no longer exists.',
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
