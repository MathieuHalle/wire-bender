// Dev only: seal sessions with the data folder's session secret.
//
// nuxt-auth-utils 0.6 derives its session key from Nuxt's `appSecret`, which the Nitro
// worker reads from NUXT_APP_SECRET when it loads (and then freezes); a server plugin is too
// late to set it. In public mode this module puts the session secret (NUXT_APP_SECRET,
// NUXT_SESSION_PASSWORD, or `<data>/session-secret`, made once) there before Nitro starts its
// worker, which copies this process's environment, so `pnpm dev:public` sessions survive
// restarts. A production server is started with NUXT_APP_SECRET set (server/plugins/startup.ts
// refuses public mode otherwise, naming the command). Local mode is left alone.
import { defineNuxtModule } from 'nuxt/kit'
import { dataDir } from '../server/db'
import { checkMode, devAppSecret } from '../server/utils/mode'

export default defineNuxtModule({
  meta: { name: 'wirebender-session-secret' },
  setup(_options, nuxt) {
    if (!nuxt.options.dev) return
    // Local mode reads no session: no file is made and the secret can never stop it.
    const secret = devAppSecret(checkMode(process.env), dataDir(), process.env)
    if (secret === undefined) return
    process.env.NUXT_APP_SECRET = secret
    // Not Nuxt's generated development secret: no warning that it is.
    delete process.env.NUXT_APP_SECRET_GENERATED
  }
})
