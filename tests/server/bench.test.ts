import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { benchResponse, benchFilename } from '../../server/utils/bench'
import { benchHtml, tickKey } from '../../export/benchHtml'
import { parseBoard } from '~core/schema'

const FIXTURE = path.resolve(__dirname, '../fixtures/channel-board-2.json')
let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wirebender-bench-'))
  file = path.join(dir, 'board.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('benchResponse', () => {
  it('serves the bench sheet for a valid board, keyed like the CLI export', async () => {
    const bytes = await fs.readFile(FIXTURE)
    await fs.writeFile(file, bytes)
    const r = await benchResponse(file, '2026-11-05')
    expect(r.status).toBe(200)
    expect(r.contentType).toBe('text/html; charset=utf-8')
    expect(r.filename).toBe('Channel-board-2.bench.html')
    expect(r.body).toContain('Channel board 2')
    // Same 12-char prefix as `wirebender export` (cli/wirebender.ts), same ticks.
    const cliHash = createHash('sha256').update(bytes.toString('utf8')).digest('hex').slice(0, 12)
    expect(r.body).toContain(`wirebender:Channel board 2:${cliHash}`)
    const parsed = parseBoard(JSON.parse(bytes.toString('utf8')))
    if (!parsed.ok) throw new Error('fixture should parse')
    expect(r.body).toBe(benchHtml(parsed.board, { hash: cliHash, date: '2026-11-05' }))
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(r.headers['content-disposition']).toBe('inline; filename="Channel-board-2.bench.html"')
  })

  it('answers 422 plain text with the parse errors for an invalid board', async () => {
    await fs.writeFile(file, '{ nope')
    const r = await benchResponse(file)
    expect(r.status).toBe(422)
    expect(r.contentType).toBe('text/plain; charset=utf-8')
    expect(r.filename).toBeUndefined()
    expect(r.body).toMatch(/not valid JSON: /)
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['content-disposition']).toBeUndefined()
  })

  it('answers 422 with schema errors and a missing file', async () => {
    await fs.writeFile(file, JSON.stringify({ name: 'x' }))
    const bad = await benchResponse(file)
    expect(bad.status).toBe(422)
    expect(bad.body.length).toBeGreaterThan(0)
    const missing = await benchResponse(path.join(dir, 'nope.json'))
    expect(missing.status).toBe(422)
    expect(missing.body).toMatch(/^cannot read file: /m)
  })
})

describe('benchFilename', () => {
  it('keeps ASCII letters, digits and -_. and replaces everything else with -', () => {
    expect(benchFilename('Channel board 2')).toBe('Channel-board-2.bench.html')
    expect(benchFilename('a"b\r\nc;d/é_v1.2')).toBe('a-b--c-d--_v1.2.bench.html')
  })
})

describe('tickKey', () => {
  it('is the first 12 hex chars of the full sha256', () => {
    const full = createHash('sha256').update('x').digest('hex')
    expect(tickKey(full)).toBe(full.slice(0, 12))
  })
})
