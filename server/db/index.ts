import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { lockDataDir } from './lock'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }

function defaultMigrationsDir(): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    path.resolve(process.cwd(), 'server/db/migrations')
  ]
  return candidates.find(existsSync) ?? candidates[1]!
}

/** True when the migrations folder has an entry newer than the last one applied. */
function hasPendingMigration(sqlite: Database.Database, migrationsDir: string): boolean {
  const journal = JSON.parse(readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf8')) as { entries: { when: number }[] }
  const applied = sqlite.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'__drizzle_migrations\'').get()
  if (!applied) return journal.entries.length > 0
  const last = sqlite.prepare('SELECT max(created_at) AS at FROM __drizzle_migrations').get() as { at: number | null }
  return journal.entries.some(e => last.at === null || e.when > last.at)
}

function hasTables(sqlite: Database.Database): boolean {
  return sqlite.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' LIMIT 1').get() !== undefined
}

/**
 * Open (creating if needed) `<dataDir>/wirebender.sqlite`, backing it up before any pending
 * migration. The folder is locked until the database is closed: a second server on the same
 * folder is refused (see ./lock.ts).
 */
export function openDb(dataDir: string, migrationsDir: string = defaultMigrationsDir()): Db {
  mkdirSync(dataDir, { recursive: true })
  const unlock = lockDataDir(dataDir)
  let sqlite: Database.Database
  try {
    sqlite = new Database(path.join(dataDir, 'wirebender.sqlite'))
  } catch (e) {
    unlock()
    throw e
  }
  const close = sqlite.close.bind(sqlite)
  sqlite.close = () => {
    try {
      return close()
    } finally {
      unlock()
    }
  }
  try {
    sqlite.pragma('journal_mode = WAL')
    if (hasTables(sqlite) && hasPendingMigration(sqlite, migrationsDir)) {
      const backups = path.join(dataDir, 'backups')
      mkdirSync(backups, { recursive: true })
      const stamp = new Date().toISOString().replace(/:/g, '-')
      sqlite.prepare('VACUUM INTO ?').run(path.join(backups, `pre-migration-${stamp}.sqlite`))
    }
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: migrationsDir })
    return db
  } catch (e) {
    sqlite.close()
    throw e
  }
}

let instance: Db | undefined

/** The server's data folder: `WIREBENDER_DATA`, or `./.data`. */
export function dataDir(): string {
  return process.env.WIREBENDER_DATA ?? './.data'
}

/** The server's single database, opened on first use from `WIREBENDER_DATA`. */
export function useDb(): Db {
  instance ??= openDb(dataDir())
  return instance
}

/** Close the server's database, if open, which also releases the data folder's lock. */
export function closeDb(): void {
  instance?.$client.close()
  instance = undefined
}
