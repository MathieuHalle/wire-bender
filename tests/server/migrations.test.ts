import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../server/db'

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wb-mig-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('migrations', () => {
  it('a failing migration throws and leaves the database as it was', () => {
    const migrations = path.join(root, 'migrations')
    cpSync(path.resolve('server/db/migrations'), migrations, { recursive: true })
    const data = path.join(root, 'data')
    const db = openDb(data, migrations)
    const before = db.$client.prepare('SELECT name FROM sqlite_master ORDER BY name').all()
    db.$client.close()

    const journalPath = path.join(migrations, 'meta/_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    const last = journal.entries.at(-1)
    journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: '0099_bad', breakpoints: true })
    writeFileSync(journalPath, JSON.stringify(journal))
    writeFileSync(path.join(migrations, '0099_bad.sql'),
      'CREATE TABLE half_done (id integer);\n--> statement-breakpoint\nINSERT INTO half_done VALUES (1);\n--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);\n')

    expect(() => openDb(data, migrations)).toThrow()

    const raw = new Database(path.join(data, 'wirebender.sqlite'), { readonly: true })
    expect(raw.prepare('SELECT name FROM sqlite_master ORDER BY name').all()).toEqual(before)
    raw.close()
    expect(readdirSync(path.join(data, 'backups')).some(n => n.startsWith('pre-migration-'))).toBe(true)
  })
})
