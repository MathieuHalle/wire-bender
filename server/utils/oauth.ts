// The end of a GitHub or Google sign-in (server/routes/auth/*). The provider's profile is
// mapped to an account by `signIn`; the session then holds the user's id (and any unlocked share links). Tokens are
// never kept or logged.
import type { H3Event } from 'h3'
import { useDb } from '../db'
import { claimSetup, signIn, type Profile, type Provider } from './accounts'
import { checkMode, configuredProviders, publicUrl } from './mode'
import { setupOkOf, unlockedOf, whoIs } from './who'

const LABEL: Record<Provider, string> = { github: 'GitHub', google: 'Google' }

/** Sign-in exists only in public mode, for a provider whose id and secret are both set. */
export function signInAvailable(provider: Provider): boolean {
  return checkMode() === 'public' && configuredProviders().includes(provider)
}

/** The callback URL the provider sends people back to: on `WIREBENDER_URL`, never guessed from the request. */
export function redirectUrl(provider: Provider): string {
  const base = publicUrl()!.href.replace(/\/+$/, '')
  return `${base}/auth/${provider}`
}

/**
 * Signs in (or, from a signed-in session, links) with the provider's profile. Refusals go
 * to /account with the reason; a deleted, not yet purged account gets a session that only
 * reaches /account (ruling R1).
 */
export async function finishSignIn(event: H3Event, provider: Provider, profile: Profile) {
  const who = await whoIs(event)
  const current = who.kind === 'user' ? who.userId : undefined
  const r = signIn(useDb(), provider, profile, current)
  if (!r.ok) return sendRedirect(event, `/account?error=${r.reason}`, 302)
  // The setup code was entered first: this account becomes the admin (claimSetup refuses a
  // deleted one, or when an admin exists by now). The new session below drops the flag.
  if (current === undefined && !r.deleted && await setupOkOf(event)) claimSetup(useDb(), r.userId)
  if (current === undefined) {
    // Replaced, not merged: nothing from an earlier session (such as R1's flag) is kept,
    // except the share links whose password this visitor already entered.
    const unlocked = await unlockedOf(event)
    const session = r.deleted ? { user: { id: r.userId }, pendingDeletion: true } : { user: { id: r.userId } }
    await replaceUserSession(event, unlocked.length > 0 ? { ...session, unlocked } : session)
  }
  return sendRedirect(event, r.deleted ? '/account' : '/', 302)
}

/** A failed or cancelled sign-in. Only the provider and the error's status are logged (its data may hold tokens). */
export function failedSignIn(event: H3Event, provider: Provider, error: { statusCode?: number, status?: number }) {
  console.warn(`[wirebender] ${LABEL[provider]} sign-in failed (${error.statusCode ?? error.status ?? 'error'})`)
  return sendRedirect(event, '/account?error=oauth', 302)
}

/** 404 unless this provider's sign-in is available here. */
export function requireSignIn(provider: Provider): void {
  if (!signInAvailable(provider)) throw createError({ statusCode: 404, statusMessage: 'not found' })
}
