import { RETURN_KEY, returnEntry } from '~/utils/boardView'
import { needsLogin } from '~/utils/nav'

// Dashboard pages need a sign-in in public mode: remember where to come back to, then /login.
// Client only (who is signed in is per browser); never applied to /b/*.
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  const me = await useMe().load()
  if (me && needsLogin(me)) {
    try {
      sessionStorage.setItem(RETURN_KEY, returnEntry(to.path))
    } catch {
      // No storage (a private window): the user lands on the board list after signing in.
    }
    return navigateTo('/login')
  }
})
