import { closeDb, dataDir, useDb } from '../db'
import { checkMode, secretProblem, sessionSecret } from '../utils/mode'

// The mode is checked before the database is opened: a wrong mode creates nothing.
// Closing it on shutdown releases the data folder's lock.
//
// Sessions (nuxt-auth-utils 0.6) are sealed with a key derived from Nuxt's `appSecret`,
// which Nitro reads from NUXT_APP_SECRET when it loads and then freezes. The session secret
// (NUXT_SESSION_PASSWORD, or `<data>/session-secret`, made once) must be that value: in
// public mode the server does not start otherwise. `nuxt dev` sets it (modules/session-secret.ts).
export default defineNitroPlugin((nitroApp) => {
  try {
    const mode = checkMode(process.env)
    useDb()
    const problem = secretProblem(mode, useRuntimeConfig().appSecret, sessionSecret(dataDir(), process.env))
    if (problem) throw new Error(problem)
  } catch (e) {
    // Shown in the terminal too: under `nuxt dev` the error otherwise only reaches requests.
    console.error(`[wirebender] ${(e as Error).message}`)
    throw e
  }
  nitroApp.hooks.hook('close', closeDb)
})
