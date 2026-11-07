import { failedSignIn, finishSignIn, redirectUrl, requireSignIn } from '../../utils/oauth'

// `GET /auth/github`: off to GitHub, and back here with a code. No scope: the public
// profile (id, login, name, avatar) is all that is read; no email.
export default defineEventHandler((event) => {
  requireSignIn('github')
  // The library's callbacks get this same event; the outer one keeps its h3 type.
  const handler = defineOAuthGitHubEventHandler({
    config: { redirectURL: redirectUrl('github'), emailRequired: false, scope: [] },
    onSuccess: (_event, { user }) => finishSignIn(event, 'github', {
      id: String(user.id),
      name: String(user.name || user.login || ''),
      avatar: typeof user.avatar_url === 'string' ? user.avatar_url : undefined
    }),
    onError: (_event, error) => failedSignIn(event, 'github', error)
  })
  return handler(event as unknown as Parameters<typeof handler>[0])
})
