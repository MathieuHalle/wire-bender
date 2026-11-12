// A deleted account waiting for its restore (ruling R1) only reaches /account/deleted and
// /logout. The server sends every page load there; this does the same for links followed
// in the app, which never reach the server as a page. Uses the `me` already loaded: no fetch.
import { pendingDeletionTarget } from '~/utils/nav'

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return
  const target = pendingDeletionTarget(useMe().me.value, to.path)
  if (target) return navigateTo(target, { replace: true })
})
