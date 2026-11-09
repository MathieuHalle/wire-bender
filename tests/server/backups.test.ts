import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_EVERY_MS, BACKUP_KEEP, backupDue, runBackup } from '../../server/utils/backups'

let dir: string
let db: Database.Database
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wb-backup-'))
  db = new Database(path.join(dir, 'wirebender.sqlite'))
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('first')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const names = () => readdirSync(path.join(dir, 'backups')).sort()

describe('backups', () => {
  it('constants', () => {
    expect(BACKUP_KEEP).toBe(14)
    expect(BACKUP_EVERY_MS).toBe(24 * 3600_000)
  })

  it('runBackup writes a snapshot that opens and passes integrity_check', async () => {
    const now = Date.parse('2026-11-09T10:20:30.000Z')
    const r = await runBackup(db, dir, { now })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(path.basename(r.file)).toBe('daily-2026-11-09T10-20-30.000Z.sqlite')
    const snap = new Database(r.file, { readonly: true })
    expect(snap.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(snap.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 })
    snap.close()
  })

  it('a backup taken during writes holds a consistent database', async () => {
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 20000; i++) ins.run('x'.repeat(200))
    let stop = false
    let written = 0
    const writer = (async () => {
      while (!stop) {
        db.transaction(() => {
          for (let i = 0; i < 50; i++) ins.run('y')
          written += 50
        })()
        await new Promise(resolve => setImmediate(resolve))
      }
    })()
    const r = await runBackup(db, dir)
    stop = true
    await writer
    expect(written).toBeGreaterThan(0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const snap = new Database(r.file, { readonly: true })
    expect(snap.pragma('integrity_check', { simple: true })).toBe('ok')
    snap.close()
  })

  it('pruning keeps the newest 14 daily snapshots and never a pre-migration file', async () => {
    const backups = path.join(dir, 'backups')
    mkdirSync(backups)
    for (let i = 1; i <= 16; i++) writeFileSync(path.join(backups, `daily-2026-10-${String(i).padStart(2, '0')}T00-00-00.000Z.sqlite`), 'old')
    writeFileSync(path.join(backups, 'pre-migration-2026-01-01T00-00-00.000Z.sqlite'), 'pre')
    const r = await runBackup(db, dir, { now: Date.parse('2026-11-09T00:00:00.000Z') })
    expect(r.ok).toBe(true)
    const all = names()
    expect(all.filter(n => n.startsWith('daily-'))).toHaveLength(14)
    expect(all).toContain('pre-migration-2026-01-01T00-00-00.000Z.sqlite')
    expect(all).toContain('daily-2026-11-09T00-00-00.000Z.sqlite')
    expect(all).not.toContain('daily-2026-10-01T00-00-00.000Z.sqlite')
    expect(all).toContain('daily-2026-10-16T00-00-00.000Z.sqlite')
  })

  it('a failed snapshot is deleted and older snapshots are kept', async () => {
    const backups = path.join(dir, 'backups')
    mkdirSync(backups)
    for (let i = 1; i <= 16; i++) writeFileSync(path.join(backups, `daily-2026-10-${String(i).padStart(2, '0')}T00-00-00.000Z.sqlite`), 'old')
    const r = await runBackup(db, dir, { now: Date.parse('2026-11-09T00:00:00.000Z'), check: () => 'database disk image is malformed' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('malformed')
    expect(existsSync(path.join(backups, 'daily-2026-11-09T00-00-00.000Z.sqlite'))).toBe(false)
    expect(names()).toHaveLength(16)
  })

  it('a throwing check does not throw out of runBackup', async () => {
    const r = await runBackup(db, dir, { check: () => {
      throw new Error('boom')
    } })
    expect(r).toEqual({ ok: false, error: 'boom' })
    expect(names()).toEqual([])
  })

  it('backupDue is false within 24 h of the last daily snapshot', () => {
    const now = Date.parse('2026-11-09T12:00:00.000Z')
    expect(backupDue(dir, now)).toBe(true)
    const backups = path.join(dir, 'backups')
    mkdirSync(backups)
    const f = path.join(backups, 'daily-x.sqlite')
    writeFileSync(f, 'a')
    utimesSync(f, new Date(now - 23 * 3600_000), new Date(now - 23 * 3600_000))
    expect(backupDue(dir, now)).toBe(false)
    utimesSync(f, new Date(now - 25 * 3600_000), new Date(now - 25 * 3600_000))
    expect(backupDue(dir, now)).toBe(true)
    rmSync(f)
    writeFileSync(path.join(backups, 'pre-migration-x.sqlite'), 'a')
    expect(backupDue(dir, now)).toBe(true)
  })
})
