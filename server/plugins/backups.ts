import { dataDir, useDb } from '../db'
import { backupDue, runBackup } from '../utils/backups'
import { createBackupTicker } from '../utils/backupTick'

const CHECK_EVERY_MS = 3600_000

// A daily online backup of the database (see README, "Data and backups"): at start when one is
// due, then checked every hour. A failure that repeats is logged once a day.
export default defineNitroPlugin((nitroApp) => {
  if (process.env.VITEST) return
  const ticker = createBackupTicker({
    dataDir,
    due: backupDue,
    run: runBackup,
    sqlite: () => useDb().$client,
    log: m => console.log(m),
    error: m => console.error(m)
  })
  // The first check is deferred: plugins run in file order, and startup.ts (after this one)
  // checks the mode before the database is first opened.
  const first = setTimeout(() => void ticker.tick(), 0)
  const timer = setInterval(() => void ticker.tick(), CHECK_EVERY_MS)
  timer.unref()
  nitroApp.hooks.hook('close', () => {
    ticker.close()
    clearTimeout(first)
    clearInterval(timer)
  })
})
