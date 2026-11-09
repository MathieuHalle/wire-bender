import { describe, expect, it, vi } from 'vitest'
import { createBackupTicker } from '../../server/utils/backupTick'

const base = () => ({
  dataDir: () => '/nowhere',
  due: vi.fn(() => true),
  run: vi.fn(async () => ({ ok: true as const, file: '/nowhere/backups/daily-x.sqlite' })),
  sqlite: vi.fn(() => ({}) as never),
  log: vi.fn(),
  error: vi.fn()
})

describe('backup ticker', () => {
  it('logs the file when a backup is written', async () => {
    const d = base()
    await createBackupTicker(d).tick(1000)
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('backup written /nowhere/backups/daily-x.sqlite'))
  })

  it('a throwing useDb is logged and does not reject', async () => {
    const d = { ...base(), sqlite: vi.fn(() => {
      throw new Error('db gone')
    }) }
    await expect(createBackupTicker(d).tick(1000)).resolves.toBeUndefined()
    expect(d.error).toHaveBeenCalledWith(expect.stringContaining('backup failed: db gone'))
  })

  it('a throwing due check is logged and does not reject', async () => {
    const d = { ...base(), due: vi.fn(() => {
      throw new Error('stat')
    }) }
    await expect(createBackupTicker(d).tick(1000)).resolves.toBeUndefined()
    expect(d.error).toHaveBeenCalledTimes(1)
  })

  it('repeated failures are logged once a day', async () => {
    const d = { ...base(), run: vi.fn(async () => ({ ok: false as const, error: 'full' })) }
    const t = createBackupTicker(d)
    await t.tick(10 * 24 * 3600_000)
    await t.tick(10 * 24 * 3600_000 + 3600_000)
    expect(d.error).toHaveBeenCalledTimes(1)
    await t.tick(11 * 24 * 3600_000 + 1)
    expect(d.error).toHaveBeenCalledTimes(2)
  })

  it('after close the tick does not run or touch the database', async () => {
    const d = base()
    const t = createBackupTicker(d)
    t.close()
    await t.tick(1000)
    expect(d.due).not.toHaveBeenCalled()
    expect(d.sqlite).not.toHaveBeenCalled()
    expect(d.run).not.toHaveBeenCalled()
  })

  it('does nothing when no backup is due', async () => {
    const d = { ...base(), due: vi.fn(() => false) }
    await createBackupTicker(d).tick(1000)
    expect(d.run).not.toHaveBeenCalled()
  })
})
