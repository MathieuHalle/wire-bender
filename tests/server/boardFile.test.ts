import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashBytes, readBoard, watchBoard, writeBoard } from '../../server/utils/boardFile'

const DEMO = path.resolve(__dirname, '../../data/channel-board-2.wirebender.json')
let dir: string
let file: string

async function demo(revision: number) {
  const board = JSON.parse(await fs.readFile(DEMO, 'utf8'))
  board.revision = revision
  return board
}

/** Write `board` as the file and return its hash, as a GET would report it. */
async function put(board: unknown): Promise<string> {
  const text = JSON.stringify(board)
  await fs.writeFile(file, text)
  return hashBytes(text)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wirebender-'))
  file = path.join(dir, 'board.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('boardFile', () => {
  it('readBoard on invalid JSON reports, doesn\'t throw', async () => {
    await fs.writeFile(file, '{ nope')
    const r = await readBoard(file)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatch(/^not valid JSON: /)
  })

  it('GET returns 422 with errors (invalid schema and missing file)', async () => {
    await fs.writeFile(file, JSON.stringify({ hello: 1 }))
    const r = await readBoard(file)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0)
    const missing = await readBoard(path.join(dir, 'nope.json'))
    expect(missing.ok).toBe(false)
  })

  it('readBoard returns the sha256 of the file bytes', async () => {
    const h = await put(await demo(0))
    const r = await readBoard(file)
    expect(r.ok && r.hash).toBe(h)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('PUT with stale baseRevision returns 409', async () => {
    const h = await put(await demo(3))
    const r = await writeBoard(file, await demo(2), 2, h)
    expect(r).toEqual({ ok: false, conflict: true, current: 3, hash: h })
  })

  it('hand edit that keeps the revision conflicts', async () => {
    const old = await put(await demo(4))
    const edited = await demo(4)
    edited.name = 'edited by hand'
    const now = await put(edited)
    const r = await writeBoard(file, await demo(4), 4, old)
    expect(r).toEqual({ ok: false, conflict: true, current: 4, hash: now })
    const back = await readBoard(file)
    expect(back.ok && back.board.name).toBe('edited by hand')
  })

  it('writeBoard on missing or unparsable file conflicts with current null', async () => {
    expect(await writeBoard(file, await demo(0), 0, 'x')).toEqual({ ok: false, conflict: true, current: null })
    await fs.writeFile(file, '{ broken')
    expect(await writeBoard(file, await demo(0), 0, hashBytes('{ broken'))).toEqual({ ok: false, conflict: true, current: null })
    expect(await fs.readFile(file, 'utf8')).toBe('{ broken')
  })

  it('write increments revision', async () => {
    const h = await put(await demo(0))
    const r = await writeBoard(file, await demo(0), 0, h)
    const back = await readBoard(file)
    expect(back.ok && back.board.revision).toBe(1)
    expect(r).toEqual({ ok: true, revision: 1, hash: back.ok && back.hash })
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('\n  "')
  })

  it('concurrent writes with the same baseRevision: one wins, one conflicts', async () => {
    const h = await put(await demo(0))
    const [a, b] = await Promise.all([
      writeBoard(file, await demo(0), 0, h),
      writeBoard(file, await demo(0), 0, h)
    ])
    const results = [a, b]
    expect(results.filter(r => r.ok).map(r => r.ok && r.revision)).toEqual([1])
    expect(results.filter(r => !r.ok).map(r => !r.ok && r.current)).toEqual([1])
  })

  it('write is atomic', async () => {
    let h = await put(await demo(0))
    let stop = false
    let reads = 0
    let bad = 0
    const reader = (async () => {
      while (!stop) {
        const r = await readBoard(file)
        reads++
        if (!r.ok) bad++
        await new Promise(res => setImmediate(res))
      }
    })()
    for (let i = 0; i < 50; i++) {
      const r = await writeBoard(file, await demo(i), i, h)
      expect(r.ok && r.revision).toBe(i + 1)
      if (r.ok) h = r.hash
    }
    stop = true
    await reader
    expect(reads).toBeGreaterThan(0)
    expect(bad).toBe(0)
    const left = (await fs.readdir(dir)).filter(f => f.endsWith('.tmp'))
    expect(left).toEqual([])
  })

  it('watchBoard fires on external write', async () => {
    await fs.writeFile(file, JSON.stringify(await demo(0)))
    const seen: (number | null)[] = []
    const stop = watchBoard(file, rev => seen.push(rev))
    await new Promise(r => setTimeout(r, 300))
    await fs.writeFile(file, JSON.stringify(await demo(7)))
    const start = Date.now()
    while (!seen.includes(7) && Date.now() - start < 5000) await new Promise(r => setTimeout(r, 50))
    stop()
    expect(seen).toContain(7)
  })
})
