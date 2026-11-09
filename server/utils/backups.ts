import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export const BACKUP_KEEP = 14
export const BACKUP_EVERY_MS = 24 * 3600_000

export type BackupResult = { ok: true, file: string } | { ok: false, error: string }

export interface BackupOptions {
  now?: number
  /** Returns 'ok' for a good snapshot, else the problem. Defaults to `PRAGMA integrity_check` on the file, opened read-only. */
  check?: (file: string) => string
}

function integrityCheck(file: string): string {
  const snap = new Database(file, { readonly: true })
  try {
    return String(snap.pragma('integrity_check', { simple: true }))
  } finally {
    snap.close()
  }
}

// Exactly the names runBackup writes (an ISO time with ':' replaced by '-').
const DAILY = /^daily-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(\.\d{3})?Z\.sqlite$/

function dailyFiles(dataDir: string): string[] {
  try {
    return readdirSync(path.join(dataDir, 'backups')).filter(n => DAILY.test(n)).sort()
  } catch {
    return []
  }
}

/**
 * Online backup (SQLite's backup API, safe while the server writes) to
 * `<dataDir>/backups/daily-<time>.sqlite`. The snapshot must pass `integrity_check` before older
 * `daily-*` files are pruned to the newest 14. A bad snapshot is deleted. Never throws.
 */
export async function runBackup(sqlite: Database.Database, dataDir: string, options: BackupOptions = {}): Promise<BackupResult> {
  const backups = path.join(dataDir, 'backups')
  const stamp = new Date(options.now ?? Date.now()).toISOString().replace(/:/g, '-')
  const file = path.join(backups, `daily-${stamp}.sqlite`)
  try {
    mkdirSync(backups, { recursive: true })
    await sqlite.backup(file)
    // The copy inherits WAL mode; make it one self-contained file (no -wal/-shm beside it).
    const snap = new Database(file)
    try {
      snap.pragma('journal_mode = DELETE')
    } finally {
      snap.close()
    }
    const verdict = (options.check ?? integrityCheck)(file)
    if (verdict !== 'ok') throw new Error(`integrity_check failed: ${verdict}`)
    // Newest 14 by name (a fixed-width time), and never the file just written, even if the
    // clock stepped back and its name sorts oldest.
    const keep = [...dailyFiles(dataDir).filter(n => n !== path.basename(file)).slice(-(BACKUP_KEEP - 1)), path.basename(file)]
    for (const old of dailyFiles(dataDir)) if (!keep.includes(old)) rmSync(path.join(backups, old), { force: true })
    return { ok: true, file }
  } catch (e) {
    try {
      rmSync(file, { force: true })
      rmSync(`${file}-wal`, { force: true })
      rmSync(`${file}-shm`, { force: true })
    } catch { /* nothing more to do */ }
    return { ok: false, error: (e as Error).message }
  }
}

/** True when no `daily-*` file was written in the last 24 h. */
export function backupDue(dataDir: string, now: number): boolean {
  return !dailyFiles(dataDir).some((n) => {
    try {
      return now - statSync(path.join(dataDir, 'backups', n)).mtimeMs < BACKUP_EVERY_MS
    } catch {
      return false
    }
  })
}
