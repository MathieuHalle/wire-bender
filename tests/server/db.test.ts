import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../server/db'
import { devices } from '../../server/db/schema'

const REAL_MIGRATIONS = path.resolve(__dirname, '../../server/db/migrations')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-db-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tableNames(db: ReturnType<typeof openDb>): string[] {
  const rows = db.$client.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all() as { name: string }[]
  return rows.map(r => r.name)
}

/** A copy of the real migrations folder plus one more migration with the given SQL. */
function migrationsWith(tag: string, sql: string): string {
  const migrations = path.join(dir, 'migrations')
  cpSync(REAL_MIGRATIONS, migrations, { recursive: true })
  const journalPath = path.join(migrations, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  journal.entries.push({ idx: journal.entries.length, version: '6', when: Date.now() + 1000, tag, breakpoints: true })
  writeFileSync(journalPath, JSON.stringify(journal))
  writeFileSync(path.join(migrations, `${tag}.sql`), sql)
  return migrations
}

describe('openDb', () => {
  it('opens and migrates an empty folder', () => {
    const db = openDb(path.join(dir, 'data'))
    expect(tableNames(db)).toEqual(expect.arrayContaining(['boards', 'revisions', 'devices']))
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(existsSync(path.join(dir, 'data/backups'))).toBe(false)
    db.$client.close()
  })

  it('a pending migration on a non-empty db makes a backup first', () => {
    const data = path.join(dir, 'data')
    const first = openDb(data)
    first.insert(devices).values({ id: 'd1', name: 'iPad', tokenHash: 'h', createdAt: 1, lastSeen: 1 }).run()
    first.$client.close()

    const second = openDb(data, migrationsWith('9999_extra', 'CREATE TABLE extra (id integer);'))
    expect(tableNames(second)).toContain('extra')
    second.$client.close()

    const backups = readdirSync(path.join(data, 'backups'))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^pre-migration-.*\.sqlite$/)
    const backup = new Database(path.join(data, 'backups', backups[0]!), { readonly: true })
    expect(backup.prepare('SELECT name FROM devices').all()).toEqual([{ name: 'iPad' }])
    expect(backup.prepare('SELECT name FROM sqlite_master WHERE name = \'extra\'').all()).toEqual([])
    backup.close()
  })

  it('reopening with nothing pending makes no backup', () => {
    openDb(dir).$client.close()
    openDb(dir).$client.close()
    expect(existsSync(path.join(dir, 'backups'))).toBe(false)
  })

  it('reopen keeps data', () => {
    const first = openDb(dir)
    first.insert(devices).values({ id: 'd1', name: 'iPad', tokenHash: 'h', createdAt: 1, lastSeen: 2 }).run()
    first.$client.close()
    const second = openDb(dir)
    expect(second.select().from(devices).all()).toEqual([{ id: 'd1', name: 'iPad', tokenHash: 'h', createdAt: 1, lastSeen: 2 }])
    second.$client.close()
  })

  it('a failing migration throws and leaves the database as it was', () => {
    const data = path.join(dir, 'data')
    openDb(data).$client.close()
    const bad = migrationsWith('9999_bad', 'CREATE TABLE half (id integer);\n--> statement-breakpoint\nNOT SQL;')

    expect(() => openDb(data, bad)).toThrow()
    const db = openDb(data)
    expect(tableNames(db)).not.toContain('half')
    db.$client.close()
  })

  it('a second open of the same folder is refused, naming it, until the first closes', () => {
    const data = path.join(dir, 'data')
    const first = openDb(data)
    expect(readFileSync(path.join(data, 'wirebender.lock'), 'utf8')).toBe(`${process.pid}:${threadId}\n`)
    expect(() => openDb(data)).toThrow(data)
    first.$client.close()
    expect(existsSync(path.join(data, 'wirebender.lock'))).toBe(false)
    const second = openDb(data)
    expect(tableNames(second)).toContain('boards')
    second.$client.close()
  })

  it('a stale lock (its process is gone) is taken over', () => {
    const data = path.join(dir, 'data')
    mkdirSync(data, { recursive: true })
    writeFileSync(path.join(data, 'wirebender.lock'), '999999999:0\n')
    const db = openDb(data)
    expect(readFileSync(path.join(data, 'wirebender.lock'), 'utf8')).toBe(`${process.pid}:${threadId}\n`)
    db.$client.close()
  })

  it('another live process holding the lock is refused; another thread of this one (a dev reload) takes over', () => {
    const data = path.join(dir, 'data')
    mkdirSync(data, { recursive: true })
    const lock = path.join(data, 'wirebender.lock')
    writeFileSync(lock, `${process.ppid}:0\n`)
    expect(() => openDb(data)).toThrow(/another WireBender server/)
    expect(readFileSync(lock, 'utf8')).toBe(`${process.ppid}:0\n`)
    writeFileSync(lock, `${process.pid}:${threadId + 1000}\n`)
    const db = openDb(data)
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}:${threadId}\n`)
    db.$client.close()
  })

  it('closing does not remove a lock someone else has taken over', () => {
    const data = path.join(dir, 'data')
    const db = openDb(data)
    const lock = path.join(data, 'wirebender.lock')
    writeFileSync(lock, `${process.pid}:${threadId + 1000}\n`)
    db.$client.close()
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}:${threadId + 1000}\n`)
  })

  it('a failed open releases the lock', () => {
    const data = path.join(dir, 'data')
    openDb(data).$client.close()
    expect(() => openDb(data, migrationsWith('9999_bad', 'NOT SQL;'))).toThrow()
    expect(existsSync(path.join(data, 'wirebender.lock'))).toBe(false)
  })
})

describe('migration to accounts', () => {
  it('migration keeps step 1 boards and gives them to the local user', () => {
    const data = path.join(dir, 'data')
    mkdirSync(data, { recursive: true })
    // Step 1 database: only the first migration, applied with drizzle so the journal is real.
    const first = path.join(dir, 'first')
    mkdirSync(path.join(first, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(path.join(REAL_MIGRATIONS, 'meta/_journal.json'), 'utf8'))
    const zero = journal.entries[0]
    writeFileSync(path.join(first, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: [zero] }))
    cpSync(path.join(REAL_MIGRATIONS, `${zero.tag}.sql`), path.join(first, `${zero.tag}.sql`))
    const old = openDb(data, first)
    const ins = old.$client.prepare('INSERT INTO boards (id, name, created_at, updated_at, current, head) VALUES (?, ?, 1, 2, \'{}\', 2)')
    ins.run('b1', 'One')
    ins.run('b2', 'Two')
    const rev = old.$client.prepare('INSERT INTO revisions (board_id, n, created_at, author, how, summary, board) VALUES (?, ?, 1, \'Local\', \'edit\', \'s\', \'{}\')')
    for (const [b, n] of [['b1', 1], ['b1', 2], ['b2', 1], ['b2', 2]] as const) rev.run(b, n)
    old.$client.close()

    const db = openDb(data)
    const rows = db.$client.prepare('SELECT id, owner_id, link_id, visibility, trashed_at FROM boards ORDER BY id').all() as { id: string, owner_id: string, link_id: string, visibility: string, trashed_at: number | null }[]
    expect(rows.map(r => [r.id, r.owner_id, r.visibility, r.trashed_at])).toEqual([['b1', 'local', 'view', null], ['b2', 'local', 'view', null]])
    for (const r of rows) expect(r.link_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(rows[0]!.link_id).not.toBe(rows[1]!.link_id)
    expect(db.$client.prepare('SELECT count(*) AS n FROM revisions').get()).toEqual({ n: 4 })
    expect(db.$client.prepare('SELECT id, name, is_admin, is_premium, suspended_at, deleted_at FROM users').all())
      .toEqual([{ id: 'local', name: 'Local', is_admin: 1, is_premium: 1, suspended_at: null, deleted_at: null }])
    const info = db.$client.prepare('PRAGMA table_info(boards)').all() as { name: string, notnull: number }[]
    expect(info.find(c => c.name === 'link_id')!.notnull).toBe(1)
    expect(() => db.$client.prepare('INSERT INTO boards (id, name, created_at, updated_at, current, head, link_id) VALUES (\'x\', \'x\', 1, 1, \'{}\', 1, ?)').run(rows[0]!.link_id)).toThrow(/UNIQUE/)
    expect(tableNames(db)).toEqual(expect.arrayContaining(['users', 'identities', 'setup', 'link_visits']))
    db.$client.close()
  })
})
