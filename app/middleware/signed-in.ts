import { RETURN_KEY, returnEntry } from '~/utils/boardView'
import { needsLogin } from '~/utils/nav'

// Dashboard pages need a sign-in in public mode: remember where to come back to, then /login.
// Client only (who is signed in is per browser); never applied to /b/*.
async function checkSignedIn(path: string) {
  const me = await useMe().load()
  if (me && needsLogin(me)) {
    try {
      sessionStorage.setItem(RETURN_KEY, returnEntry(path))
    } catch {
      // No storage (a private window): the user lands on the board list after signing in.
    }
    await navigateTo('/login')
  }
}

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return
  const nuxtApp = useNuxtApp()
  // Loading `me` before hydration would make the client render differ from the server's
  // (which has no session): wait until the page is hydrated, then check.
  if (nuxtApp.isHydrating && nuxtApp.payload.serverRendered) {
    const path = to.path
    onNuxtReady(() => void checkSignedIn(path))
    return
  }
  return checkSignedIn(to.path)
})
