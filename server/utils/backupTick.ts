import type Database from 'better-sqlite3'
import { BACKUP_EVERY_MS, type BackupResult } from './backups'

export interface BackupTickDeps {
  dataDir: () => string
  due: (dataDir: string, now: number) => boolean
  run: (sqlite: Database.Database, dataDir: string, options: { now: number }) => Promise<BackupResult>
  /** The live database handle. May throw. */
  sqlite: () => Database.Database
  log: (message: string) => void
  error: (message: string) => void
}

/**
 * The backup plugin's check, with its dependencies injected. `tick` never rejects: every
 * failure is logged (at most once a day), and after `close` it does nothing, so a late timer
 * never reopens the database.
 */
export function createBackupTicker(deps: BackupTickDeps) {
  let running = false
  let closed = false
  let lastFailureLog = -Infinity
  const fail = (message: string, now: number) => {
    if (now - lastFailureLog < BACKUP_EVERY_MS) return
    lastFailureLog = now
    deps.error(`[wirebender] backup failed: ${message}`)
  }
  return {
    async tick(now: number = Date.now()): Promise<void> {
      if (closed || running) return
      running = true
      try {
        const dir = deps.dataDir()
        if (!deps.due(dir, now)) return
        const r = await deps.run(deps.sqlite(), dir, { now })
        if (r.ok) deps.log(`[wirebender] backup written ${r.file}`)
        else fail(r.error, now)
      } catch (e) {
        fail((e as Error).message, now)
      } finally {
        running = false
      }
    },
    close(): void {
      closed = true
    }
  }
}
