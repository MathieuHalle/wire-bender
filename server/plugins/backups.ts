import { dataDir, useDb } from '../db'
import { BACKUP_EVERY_MS, backupDue, runBackup } from '../utils/backups'

const CHECK_EVERY_MS = 3600_000

// A daily online backup of the database (see README, "Data and backups"): at start when one is
// due, then checked every hour. A failure that repeats is logged once a day.
export default defineNitroPlugin((nitroApp) => {
  if (process.env.VITEST) return
  let running = false
  let lastFailureLog = 0
  const tick = async () => {
    const now = Date.now()
    if (running || !backupDue(dataDir(), now)) return
    running = true
    try {
      const r = await runBackup(useDb().$client, dataDir(), { now })
      if (r.ok) {
        console.log(`[wirebender] backup written ${r.file}`)
      } else if (now - lastFailureLog >= BACKUP_EVERY_MS) {
        lastFailureLog = now
        console.error(`[wirebender] backup failed: ${r.error}`)
      }
    } finally {
      running = false
    }
  }
  // The first check is deferred: plugins run in file order, and startup.ts (after this one)
  // checks the mode before the database is first opened.
  const first = setTimeout(() => void tick(), 0)
  const timer = setInterval(() => void tick(), CHECK_EVERY_MS)
  timer.unref()
  nitroApp.hooks.hook('close', () => {
    clearTimeout(first)
    clearInterval(timer)
  })
})
