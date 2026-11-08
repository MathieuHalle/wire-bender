import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseBoard, type BoardFile } from '~core/schema'
import { BUNDLE_FORMAT, MAX_BUNDLE_BYTES, MAX_BUNDLE_REVISIONS, encodeBundle, decodeBundle, type Bundle } from '~core/bundle'

const board = (): BoardFile => {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/channel-board-2.json', import.meta.url)), 'utf8'))
  const res = parseBoard(raw)
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const rev = (n: number, b: BoardFile) => ({ n, createdAt: 1000 + n, author: 'Ana', how: 'edit', target: n > 1 ? n - 1 : null, summary: `rev ${n}`, board: b })
const json = (v: unknown) => strToU8(JSON.stringify(v))

describe('board bundles', () => {
  it('encode then decode round-trips channel board 2 with 3 revisions', () => {
    const b = board()
    const bundle: Bundle = { name: 'Channel 2', exportedAt: 5000, board: b, revisions: [rev(3, b), rev(1, b), rev(2, b)] }
    const res = decodeBundle(encodeBundle(bundle))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bundle.name).toBe('Channel 2')
    expect(res.bundle.exportedAt).toBe(5000)
    expect(res.bundle.board).toEqual(b)
    expect(res.bundle.revisions.map(r => r.n)).toEqual([1, 2, 3])
    expect(res.bundle.revisions[1]).toEqual(rev(2, b))
  })

  it('a bundle with a revision that fails parseBoard is 422 naming the revision', () => {
    const b = board()
    const zip = zipSync({
      'manifest.json': json({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 1, revisions: 2 }),
      'board.wirebender.json': json(b),
      'revisions/000001.json': json(rev(1, b)),
      'revisions/000002.json': json({ ...rev(2, b), board: { nope: true } })
    })
    const res = decodeBundle(zip)
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error.startsWith('revisions/000002.json:')).toBe(true)
  })

  it('missing board.wirebender.json is 422 "bundle has no board.wirebender.json"', () => {
    const zip = zipSync({ 'manifest.json': json({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 1, revisions: 0 }) })
    expect(decodeBundle(zip)).toEqual({ ok: false, status: 422, error: 'bundle has no board.wirebender.json' })
  })

  it('an unknown manifest format is 422 "unsupported bundle format wirebender-bundle/2"', () => {
    const zip = zipSync({
      'manifest.json': json({ format: 'wirebender-bundle/2', name: 'x', exportedAt: 1, revisions: 0 }),
      'board.wirebender.json': json(board())
    })
    expect(decodeBundle(zip)).toEqual({ ok: false, status: 422, error: 'unsupported bundle format wirebender-bundle/2' })
  })

  it('a zip over MAX_BUNDLE_BYTES is 413', () => {
    const res = decodeBundle(new Uint8Array(MAX_BUNDLE_BYTES + 1))
    expect(res).toMatchObject({ ok: false, status: 413 })
  })

  it('an entry whose uncompressed size is over the board cap is 413 without inflating it', () => {
    const zip = zipSync({
      'manifest.json': json({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 1, revisions: 0 }),
      'board.wirebender.json': new Uint8Array(3_000_000)
    })
    expect(zip.length).toBeLessThan(100_000)
    const res = decodeBundle(zip)
    expect(res).toMatchObject({ ok: false, status: 413 })
    if (!res.ok) expect(res.error).toContain('board.wirebender.json')
    expect(decodeBundle(zip, { maxBoardBytes: 5_000_000 })).toMatchObject({ ok: false, status: 422 })
  })

  it('non-zip bytes are 422 "not a zip file"', () => {
    expect(decodeBundle(strToU8('hello, this is not a zip'))).toEqual({ ok: false, status: 422, error: 'not a zip file' })
  })

  it('more than MAX_BUNDLE_REVISIONS revisions is 413', () => {
    const files: Record<string, Uint8Array> = {
      'manifest.json': json({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 1, revisions: MAX_BUNDLE_REVISIONS + 1 }),
      'board.wirebender.json': json(board())
    }
    const empty = new Uint8Array(0)
    for (let i = 1; i <= MAX_BUNDLE_REVISIONS + 1; i++) files[`revisions/${String(i).padStart(6, '0')}.json`] = empty
    const res = decodeBundle(zipSync(files, { level: 0 }))
    expect(res).toMatchObject({ ok: false, status: 413 })
  })
})
