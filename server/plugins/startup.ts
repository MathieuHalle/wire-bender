import { closeDb, dataDir, useDb } from '../db'
import { schedulePurge } from '../utils/lifecycle'
import { checkMode, startupSecretProblem } from '../utils/mode'

// The mode is checked before the database is opened: a wrong mode creates nothing.
// Closing it on shutdown releases the data folder's lock.
//
// Sessions (nuxt-auth-utils 0.6) are sealed with a key derived from Nuxt's `appSecret`,
// which Nitro reads from NUXT_APP_SECRET when it loads and then freezes. In public mode the
// session secret (NUXT_APP_SECRET, NUXT_SESSION_PASSWORD, or `<data>/session-secret`, made
// once) must be that value: the server does not start otherwise, and says what to set.
// `nuxt dev` sets it (modules/session-secret.ts). Local mode reads no session: no secret.
export default defineNitroPlugin((nitroApp) => {
  try {
    const mode = checkMode(process.env)
    useDb()
    const problem = startupSecretProblem(mode, useRuntimeConfig().appSecret, dataDir(), process.env)
    if (problem) throw new Error(problem)
  } catch (e) {
    // Shown in the terminal too: under `nuxt dev` the error otherwise only reaches requests.
    console.error(`[wirebender] ${(e as Error).message}`)
    throw e
  }
  // Trashed boards and deleted accounts past their 30 days: at start, then once a day (an
  // unref'd timer: it never keeps the process alive). Never under the test runner.
  if (!process.env.VITEST) {
    const stop = schedulePurge(useDb(), {
      log: (r) => {
        if (r.boards > 0 || r.users > 0) console.log(`[wirebender] purged ${r.boards} board(s) and ${r.users} account(s)`)
      }
    })
    nitroApp.hooks.hook('close', stop)
  }
  nitroApp.hooks.hook('close', closeDb)
})
