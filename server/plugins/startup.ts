import { closeDb, useDb } from '../db'
import { checkMode } from '../utils/access'

// The mode is checked before the database is opened: a wrong mode creates nothing.
// Closing it on shutdown releases the data folder's lock.
export default defineNitroPlugin((nitroApp) => {
  checkMode(process.env)
  try {
    useDb()
  } catch (e) {
    // Shown in the terminal too: under `nuxt dev` the error otherwise only reaches requests.
    console.error(`[wirebender] ${(e as Error).message}`)
    throw e
  }
  nitroApp.hooks.hook('close', closeDb)
})
