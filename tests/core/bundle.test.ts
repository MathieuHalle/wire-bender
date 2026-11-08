import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { parseBoard, type BoardFile } from '~core/schema'
import { BUNDLE_FORMAT, MAX_BUNDLE_BYTES, MAX_BUNDLE_REVISIONS, encodeBundle, decodeBundle, type Bundle } from '~core/bundle'

const spy = vi.hoisted(() => ({ allowed: [] as number[], inject: null as Record<string, Uint8Array> | null }))
vi.mock('fflate', async (orig) => {
  const actual = await orig<typeof import('fflate')>()
  return {
    ...actual,
    // Records what the filter let through, and can add entries after unzipping, as if one inflated past its header.
    unzipSync: (data: Uint8Array, opts?: { filter?: (f: { name: string, size: number, originalSize: number }) => boolean }) => {
      const filter = opts?.filter
      const files = actual.unzipSync(data, {
        ...opts,
        filter: filter && ((f: { name: string, size: number, originalSize: number }) => {
          const r = filter(f)
          if (r) spy.allowed.push(Math.max(f.size, f.originalSize))
          return r
        })
      } as never)
      return spy.inject ? { ...files, ...spy.inject } : files
    }
  }
})
beforeEach(() => {
  spy.allowed = []
  spy.inject = null
})

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

  const manifest = () => json({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 1, revisions: 0 })
  const good = () => ({ 'manifest.json': manifest(), 'board.wirebender.json': json(board()) })

  /** Rewrite the sizes the central directory declares for one entry. */
  function patchSizes(zip: Uint8Array, name: string, sizes: { size?: number, originalSize?: number, compression?: number }): Uint8Array {
    const out = zip.slice()
    const v = new DataView(out.buffer)
    for (let i = 0; i < out.length - 46; i++) {
      if (v.getUint32(i, true) !== 0x02014b50) continue
      const nlen = v.getUint16(i + 28, true)
      if (strFromU8(out.subarray(i + 46, i + 46 + nlen)) !== name) continue
      if (sizes.compression !== undefined) v.setUint16(i + 10, sizes.compression, true)
      if (sizes.size !== undefined) v.setUint32(i + 20, sizes.size, true)
      if (sizes.originalSize !== undefined) v.setUint32(i + 24, sizes.originalSize, true)
      return out
    }
    throw new Error('no such entry')
  }

  /** A stored zip with one local entry (`data`) that `names.length` central entries all point at, each declaring `declared` bytes. */
  function overlapping(names: string[], data: Uint8Array, declared: number): Uint8Array {
    const parts: Uint8Array[] = []
    const u16 = (n: number) => [n & 255, n >> 8]
    const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
    const first = strToU8(names[0]!)
    parts.push(Uint8Array.from([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(first.length), ...u16(0), ...first]), data)
    const cdStart = 30 + first.length + data.length
    let cdSize = 0
    for (const n of names) {
      const nb = strToU8(n)
      const c = Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(declared), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...nb])
      parts.push(c)
      cdSize += c.length
    }
    parts.push(Uint8Array.from([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(names.length), ...u16(names.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)]))
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }

  it('stored entries that declare a tiny originalSize are counted by their real size (C1)', () => {
    const names = Array.from({ length: 400 }, (_, i) => `revisions/${String(i + 1).padStart(6, '0')}.json`)
    const zip = overlapping(names, new Uint8Array(1_500_000), 1)
    const res = decodeBundle(zip)
    expect(res).toMatchObject({ ok: false, status: 422 })
    // The refusal came from the filter, before any copy: no entry was let through.
    expect(spy.allowed).toEqual([])
  })

  it('stored entries that truly are large are counted against the unzipped total (C1)', () => {
    const names = Array.from({ length: 400 }, (_, i) => `revisions/${String(i + 1).padStart(6, '0')}.json`)
    const res = decodeBundle(overlapping(names, new Uint8Array(1_500_000), 1_500_000))
    expect(res).toMatchObject({ ok: false, status: 413 })
    expect(spy.allowed.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200_000_000)
    expect(spy.allowed.length).toBeLessThan(140)
  })

  it('a stored entry whose size and originalSize differ is 422 naming it (C1)', () => {
    const zip = patchSizes(zipSync(good(), { level: 0 }), 'manifest.json', { originalSize: 3 })
    const res = decodeBundle(zip)
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error).toContain('manifest.json')
  })

  it('a compression method other than 0 or 8 is 422 naming the entry (C1)', () => {
    const zip = patchSizes(zipSync(good()), 'manifest.json', { compression: 12 })
    const res = decodeBundle(zip)
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error).toContain('manifest.json')
  })

  it('a deflate entry whose header declares 3 MB is refused on the header alone (I2)', () => {
    const zip = patchSizes(zipSync(good()), 'board.wirebender.json', { originalSize: 3_000_000 })
    const res = decodeBundle(zip)
    expect(res).toMatchObject({ ok: false, status: 413 })
    if (!res.ok) expect(res.error).toContain('board.wirebender.json')
  })

  it('an entry that inflates past the cap despite its header is 413 (I2)', () => {
    spy.inject = { 'board.wirebender.json': new Uint8Array(3_000_000) }
    const res = decodeBundle(zipSync(good()))
    expect(res).toMatchObject({ ok: false, status: 413 })
  })

  it('declared sizes that add up past the unzipped cap are 413 (I2)', () => {
    const res = decodeBundle(zipSync(good()), { maxUnzipped: 1000 })
    expect(res).toMatchObject({ ok: false, status: 413 })
  })

  it('a board with another format is 422 "unsupported bundle format" (I1)', () => {
    const b = board()
    const future = { ...b, format: 'wirebender/2' }
    expect(decodeBundle(zipSync({ ...good(), 'board.wirebender.json': json(future) })))
      .toEqual({ ok: false, status: 422, error: 'unsupported bundle format wirebender/2' })
    const withRev = zipSync({ ...good(), 'revisions/000001.json': json({ ...rev(1, b), board: future }) })
    expect(decodeBundle(withRev)).toEqual({ ok: false, status: 422, error: 'unsupported bundle format wirebender/2' })
  })

  it('a current board that fails parseBoard is 422 naming board.wirebender.json (I2)', () => {
    const res = decodeBundle(zipSync({ ...good(), 'board.wirebender.json': json({ nope: true }) }))
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error.startsWith('board.wirebender.json:')).toBe(true)
  })

  it('revisions come back sorted by n whatever the zip order (I2)', () => {
    const b = board()
    const res = decodeBundle(zipSync({ ...good(), 'revisions/000010.json': json(rev(10, b)), 'revisions/000002.json': json(rev(2, b)), 'revisions/000001.json': json(rev(1, b)) }))
    expect(res.ok && res.bundle.revisions.map(r => r.n)).toEqual([1, 2, 10])
  })

  it('an entry outside the layout is 422 naming it (S2)', () => {
    for (const name of ['notes.txt', 'revisions/abc.json', 'revisions/sub/000002.json', 'revisions/1.json']) {
      const res = decodeBundle(zipSync({ ...good(), [name]: json({}) }))
      expect(res).toMatchObject({ ok: false, status: 422 })
      if (!res.ok) expect(res.error).toContain(name)
    }
  })

  it('a revision file name that does not match its n is 422 naming it (S2)', () => {
    const res = decodeBundle(zipSync({ ...good(), 'revisions/000002.json': json(rev(3, board())) }))
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error.startsWith('revisions/000002.json:')).toBe(true)
  })

  it('a duplicate n is 422 naming the entry (S2)', () => {
    // Two central entries with distinct names cannot share an n under the strict layout, so the name check catches it.
    const b = board()
    const res = decodeBundle(zipSync({ ...good(), 'revisions/000001.json': json(rev(1, b)), 'revisions/000002.json': json(rev(1, b)) }))
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error.startsWith('revisions/000002.json:')).toBe(true)
  })

  it('a non-finite createdAt, a bad target, or a missing manifest name is 422 (minors)', () => {
    const b = board()
    const raw = (o: object) => strToU8(JSON.stringify({ ...rev(1, b), ...o }).replace('"createdAt":1001', '"createdAt":1e400'))
    expect(decodeBundle(zipSync({ ...good(), 'revisions/000001.json': raw({}) }))).toMatchObject({ ok: false, status: 422 })
    expect(decodeBundle(zipSync({ ...good(), 'revisions/000001.json': json({ ...rev(1, b), target: -2.5 }) }))).toMatchObject({ ok: false, status: 422 })
    expect(decodeBundle(zipSync({ ...good(), 'manifest.json': json({ format: BUNDLE_FORMAT, exportedAt: 1 }) }))).toMatchObject({ ok: false, status: 422 })
  })

  it('error messages carry no control characters from entry names (minor)', () => {
    const res = decodeBundle(zipSync({ ...good(), ['x\u0001\u0002' + 'y'.repeat(300)]: json({}) }))
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) {
      // eslint-disable-next-line no-control-regex
      expect(res.error).not.toMatch(/[\u0000-\u001f]/)
      expect(res.error.length).toBeLessThan(200)
    }
  })

  it('the board entry is byte-identical to the download route formatting (minor)', () => {
    const b = board()
    const files = unzipSync(encodeBundle({ name: 'x', exportedAt: 1, board: b, revisions: [] }))
    expect(strFromU8(files['board.wirebender.json']!)).toBe(`${JSON.stringify(b, null, 2)}\n`)
  })
})
