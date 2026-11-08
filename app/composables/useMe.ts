// Who this browser is (GET /api/me), shared by every page: the mode, the signed-in user or
// none, and the sign-in providers. Loaded on the client only: who is signed in is per browser.

export type Provider = 'github' | 'google'
export interface MeUser { id: string, name: string, avatar: string | null, isAdmin: boolean, isPremium: boolean, providers: Provider[], deletedAt: number | null }
export interface Me { mode: 'local' | 'public', user: MeUser | null, providers: Provider[] }

/** Hosts the sign-in providers serve avatars from; any other avatar URL (a peer can claim one) is not loaded. */
const AVATAR_HOSTS = new Set(['avatars.githubusercontent.com', 'lh3.googleusercontent.com'])

/** `url` if it is an https avatar from a sign-in provider, else undefined. */
export function safeAvatar(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && AVATAR_HOSTS.has(u.hostname) ? url : undefined
  } catch {
    return undefined
  }
}

export function useMe() {
  const me = useState<Me | null>('me', () => null)
  /** The last load failed (the server could not be reached). */
  const failed = useState('me-failed', () => false)
  const loading = useState('me-loading', () => false)

  /** Loads /api/me (again with `force`); resolves to it, or null when it could not be read. */
  async function load(force = false): Promise<Me | null> {
    if (me.value && !force) return me.value
    loading.value = true
    try {
      me.value = await $fetch<Me>('/api/me')
      failed.value = false
    } catch {
      failed.value = true
    } finally {
      loading.value = false
    }
    return me.value
  }

  /** Signs out (nuxt-auth-utils' session route), then reads who we are again. */
  async function signOut() {
    await $fetch('/api/_auth/session', { method: 'DELETE' })
    await load(true)
  }

  return { me, failed, loading, load, signOut }
}
