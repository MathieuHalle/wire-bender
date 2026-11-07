import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { benchResponse, benchFilename } from '../../server/utils/bench'
import { benchHtml, tickKey } from '../../export/benchHtml'
import { parseBoard } from '~core/schema'

const FIXTURE = path.resolve(__dirname, '../fixtures/channel-board-2.json')

describe('benchResponse', () => {
  it('builds the bench sheet from a board, keyed by the given hash', () => {
    const parsed = parseBoard(JSON.parse(readFileSync(FIXTURE, 'utf8')))
    if (!parsed.ok) throw new Error('fixture should parse')
    const r = benchResponse(parsed.board, 'abc123abc123', '2026-11-05')
    expect(r.status).toBe(200)
    expect(r.contentType).toBe('text/html; charset=utf-8')
    expect(r.filename).toBe('Channel-board-2.bench.html')
    expect(r.body).toContain('wirebender:Channel board 2:abc123abc123')
    expect(r.body).toBe(benchHtml(parsed.board, { hash: 'abc123abc123', date: '2026-11-05' }))
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(r.headers['content-disposition']).toBe('inline; filename="Channel-board-2.bench.html"')
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
