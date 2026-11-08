/**
 * Any `/api` path no route answers: the same 404 (status, body and headers) as the admin
 * routes give a non-admin and the board routes give an unknown key, so a signed-in caller
 * can't tell a route that exists from one that doesn't. Every named route, and modules'
 * own handlers (nuxt-auth-utils' `/api/_auth/*`), are matched before this catch-all.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseStatus(event, 404)
  return { error: 'not found' }
})
