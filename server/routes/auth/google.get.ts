import { failedSignIn, finishSignIn, redirectUrl, requireSignIn } from '../../utils/oauth'

// `GET /auth/google`: off to Google, and back here with a code. Only `openid profile`:
// the stable id (`sub`), name and picture; no email.
export default defineEventHandler((event) => {
  requireSignIn('google')
  // The library's callbacks get this same event; the outer one keeps its h3 type.
  const handler = defineOAuthGoogleEventHandler({
    config: { redirectURL: redirectUrl('google'), scope: ['openid', 'profile'] },
    onSuccess: (_event, { user }) => finishSignIn(event, 'google', {
      id: String(user.sub),
      name: String(user.name || user.given_name || ''),
      avatar: typeof user.picture === 'string' ? user.picture : undefined
    }),
    onError: (_event, error) => failedSignIn(event, 'google', error)
  })
  return handler(event as unknown as Parameters<typeof handler>[0])
})
