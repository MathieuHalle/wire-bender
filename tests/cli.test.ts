import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const board2 = join(root, 'data/channel-board-2.wirebender.json')
const fixture = join(root, 'tests/fixtures/channel-board-2.json')
const ADVISORY = 'Advisory only. Check the board with a meter before powering it.'

function cli(...args: string[]) {
  const r = spawnSync(join(root, 'node_modules/.bin/tsx'), ['--tsconfig', 'tsconfig.cli.json', 'cli/wirebender.ts', ...args], {
    cwd: root, encoding: 'utf8'
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('wirebender check', () => {
  it('channel board 2: exit code matches the error count, ends with the advisory', () => {
    const r = cli('check', board2)
    const m = /(\d+) errors?/.exec(r.out)
    expect(m, r.out + r.err).not.toBeNull()
    expect(r.code).toBe(Number(m![1]) > 0 ? 1 : 0)
    expect(r.out.trimEnd().split('\n').at(-1)).toBe(ADVISORY)
  })

  it('groups errors, warnings, then cautions supply, mcu, harmless; harmless collapsed', () => {
    const lines = cli('check', board2).out.trimEnd().split('\n')
    const kinds = lines.map(l => /^(ERROR|WARNING|CAUTION \[\w+\])/.exec(l)?.[1]).filter(Boolean) as string[]
    const order = ['ERROR', 'WARNING', 'CAUTION [supply]', 'CAUTION [mcu]', 'CAUTION [harmless]']
    const ranks = kinds.map(k => order.indexOf(k))
    expect(ranks.every(r => r >= 0)).toBe(true)
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
    const harmless = lines.filter(l => l.startsWith('CAUTION [harmless]'))
    expect(harmless).toHaveLength(1)
    expect(harmless[0]).toMatch(/^CAUTION \[harmless\] \d+ more \(use --all to list\)$/)
  })

  it('--all lists every harmless caution', () => {
    const all = cli('check', board2, '--all').out
    const json = JSON.parse(cli('check', board2, '--json').out)
    const n = json.findings.filter((f: { level?: string }) => f.level === 'harmless').length
    expect(all.split('\n').filter(l => l.startsWith('CAUTION [harmless] Adjacent'))).toHaveLength(n)
  })

  it('--json prints the runCheck result', () => {
    const r = cli('check', board2, '--json')
    const json = JSON.parse(r.out)
    expect(json.stats.nets).toBeGreaterThan(0)
    expect(Array.isArray(json.findings)).toBe(true)
    expect(r.code).toBe(json.stats.errors > 0 ? 1 : 0)
  })

  it('a file with a bad hole -> exit 2 with the parse error', () => {
    const board = JSON.parse(readFileSync(board2, 'utf8'))
    board.parts[0].at = 'Z99'
    const file = join(mkdtempSync(join(tmpdir(), 'wb-cli-')), 'bad.json')
    writeFileSync(file, JSON.stringify(board))
    const r = cli('check', file)
    expect(r.code).toBe(2)
    expect(r.out).toContain('outside the')
  })

  it('a missing file -> exit 2', () => {
    expect(cli('check', join(root, 'no-such-board.json')).code).toBe(2)
  })
})

describe('wirebender export', () => {
  it('export writes the file and prints its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-export-'))
    const out = join(dir, 'sheet.html')
    const before = readFileSync(fixture, 'utf8')
    const r = cli('export', fixture, '-o', out)
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.out.trim()).toBe(out)
    const html = readFileSync(out, 'utf8')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('Channel board 2')
    expect(readFileSync(fixture, 'utf8')).toBe(before) // the board file is never changed
    // the fixture has 2 check errors: one stderr line, still exit 0
    expect(r.err.trim()).toBe('board has 2 errors — see the red box on the sheet')
  })

  it('export of a clean board writes nothing to stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-export-'))
    const board = JSON.parse(readFileSync(fixture, 'utf8'))
    Object.assign(board, { parts: [], trails: [], wires: [], legFolds: [], solderBridges: [] })
    const file = join(dir, 'clean.json')
    writeFileSync(file, JSON.stringify(board))
    const r = cli('export', file, '-o', join(dir, 'clean.html'))
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.err).toBe('')
  })

  it('export without -o writes <basename>.bench.html next to the board file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-export-'))
    const file = join(dir, 'board.wirebender.json')
    copyFileSync(fixture, file)
    const r = cli('export', file)
    expect(r.code, r.out + r.err).toBe(0)
    const out = join(dir, 'board.wirebender.bench.html')
    expect(r.out.trim()).toBe(out)
    expect(existsSync(out)).toBe(true)
  })

  it('export on an invalid file exits 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-export-'))
    const board = JSON.parse(readFileSync(fixture, 'utf8'))
    board.parts[0].at = 'Z99'
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify(board))
    const r = cli('export', file, '-o', join(dir, 'bad.html'))
    expect(r.code).toBe(2)
    expect(r.out).toContain('outside the')
    expect(existsSync(join(dir, 'bad.html'))).toBe(false)
    expect(cli('export', join(dir, 'missing.json')).code).toBe(2)
  })
})
