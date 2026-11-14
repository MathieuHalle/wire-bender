import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { zipSync, unzipSync, deflateSync, strToU8, strFromU8 } from 'fflate'
import { parseBoard, type BoardFile } from '~core/schema'
import { BUNDLE_FORMAT, MAX_BUNDLE_BYTES, MAX_BUNDLE_REVISIONS, encodeBundle, decodeBundle, type Bundle } from '~core/bundle'
import { crc32 } from '~core/crc32'

const spy = vi.hoisted(() => ({ inflated: 0 }))
vi.mock('fflate', async (orig) => {
  const actual = await orig<typeof import('fflate')>()
  // Counts every byte the inflater produces, so a test can prove the work stayed bounded.
  class CountingInflate extends actual.UnzipInflate {
    constructor() {
      super()
      const inner = (this as unknown as { i: { ondata: (d: Uint8Array, final: boolean) => void } }).i
      const next = inner.ondata
      inner.ondata = (d, final) => {
        spy.inflated += d.length
        next(d, final)
      }
    }
  }
  return { ...actual, UnzipInflate: CountingInflate }
})
beforeEach(() => {
  spy.inflated = 0
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

  const manifest = (revisions: number) => json({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 1, revisions })
  const good = (revisions = 0) => ({ 'manifest.json': manifest(revisions), 'board.wirebender.json': json(board()) })

  const u16 = (n: number) => [n & 255, n >> 8]
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]

  /** Rewrite what the headers declare for one entry, in both the local header and the central directory. */
  function patchSizes(zip: Uint8Array, name: string, sizes: { size?: number, originalSize?: number, compression?: number }): Uint8Array {
    const out = zip.slice()
    const v = new DataView(out.buffer)
    for (let i = 0; i < out.length - 46; i++) {
      if (v.getUint32(i, true) !== 0x02014b50) continue
      const nlen = v.getUint16(i + 28, true)
      if (strFromU8(out.subarray(i + 46, i + 46 + nlen)) !== name) continue
      const local = v.getUint32(i + 42, true)
      if (sizes.compression !== undefined) {
        v.setUint16(i + 10, sizes.compression, true)
        v.setUint16(local + 8, sizes.compression, true)
      }
      if (sizes.size !== undefined) {
        v.setUint32(i + 20, sizes.size, true)
        v.setUint32(local + 18, sizes.size, true)
      }
      if (sizes.originalSize !== undefined) {
        v.setUint32(i + 24, sizes.originalSize, true)
        v.setUint32(local + 22, sizes.originalSize, true)
      }
      return out
    }
    throw new Error('no such entry')
  }

  interface RawEntry { name: string, method: 0 | 8, data: Uint8Array, usize: number, csize?: number, crc?: number }

  /**
   * A hand-built zip. With `overlap`, only the first entry gets a local header and every central entry points at it.
   * Headers declare `usize` and `csize` whatever the data really is.
   */
  function buildZip(entries: RawEntry[], overlap = false, centralCount = entries.length): Uint8Array {
    const chunks: Uint8Array[] = []
    const offsets: number[] = []
    let at = 0
    const emit = (bytes: ArrayLike<number>) => {
      const c = Uint8Array.from(bytes)
      chunks.push(c)
      at += c.length
    }
    for (const [i, e] of entries.entries()) {
      if (overlap && i > 0) {
        offsets.push(offsets[0]!)
        continue
      }
      offsets.push(at)
      const nb = strToU8(e.name)
      emit([0x50, 0x4B, 3, 4, ...u16(20), ...u16(0), ...u16(e.method), ...u16(0), ...u16(0), ...u32(e.crc ?? 0), ...u32(e.csize ?? e.data.length), ...u32(e.usize), ...u16(nb.length), ...u16(0), ...nb])
      emit(e.data)
    }
    const cdStart = at
    let cdSize = 0
    for (const [i, e] of entries.slice(0, centralCount).entries()) {
      const nb = strToU8(e.name)
      const rec = [0x50, 0x4B, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(e.method), ...u16(0), ...u16(0), ...u32(e.crc ?? 0), ...u32(e.csize ?? e.data.length), ...u32(e.usize), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offsets[i]!), ...nb]
      emit(rec)
      cdSize += rec.length
    }
    emit([0x50, 0x4B, 5, 6, ...u16(0), ...u16(0), ...u16(centralCount), ...u16(centralCount), ...u32(cdSize), ...u32(cdStart), ...u16(0)])
    const out = new Uint8Array(at)
    let o = 0
    for (const c of chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  }

  const bombData = () => deflateSync(new Uint8Array(128_000_000), { level: 9 })
  const bombNames = ['manifest.json', 'board.wirebender.json', ...Array.from({ length: 38 }, (_, i) => `revisions/${String(i + 1).padStart(6, '0')}.json`)]

  it('40 overlapping entries over a deflate bomb are refused quickly with bounded inflating (C2)', () => {
    const data = bombData()
    const zip = buildZip(bombNames.map(name => ({ name, method: 8, data, usize: 1 })), true)
    const t0 = performance.now()
    const res = decodeBundle(zip)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(res).toMatchObject({ ok: false, status: 413 })
    // The cap plus one 16 KB slice's expansion, nowhere near the 128 MB the stream holds.
    expect(spy.inflated).toBeLessThan(20_000_000)
  })

  it('40 separate deflate entries that inflate far past originalSize are refused quickly (C2)', () => {
    const data = bombData()
    const zip = buildZip(bombNames.map(name => ({ name, method: 8, data, usize: 1 })))
    const t0 = performance.now()
    const res = decodeBundle(zip)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(res).toMatchObject({ ok: false, status: 413 })
    if (!res.ok) expect(res.error).toContain('manifest.json')
    expect(spy.inflated).toBeLessThan(20_000_000)
  })

  it('an entry that inflates past the cap despite its header is 413 after a bounded amount of work (C2)', () => {
    const zip = patchSizes(zipSync({ ...good(), 'board.wirebender.json': new Uint8Array(3_000_000) }), 'board.wirebender.json', { originalSize: 1 })
    const res = decodeBundle(zip)
    expect(res).toMatchObject({ ok: false, status: 413 })
    expect(spy.inflated).toBeLessThan(20_000_000)
  })

  it('a deflate entry whose compressed size is over the cap is refused before inflating (M-c)', () => {
    const noise = Uint8Array.from({ length: 2_500_000 }, (_, i) => (i * 2654435761) >>> 24)
    const data = deflateSync(noise, { level: 0 })
    const res = decodeBundle(buildZip([{ name: 'manifest.json', method: 8, data, usize: 1 }]))
    expect(res).toMatchObject({ ok: false, status: 413 })
    expect(spy.inflated).toBe(0)
  })

  it('stored entries that add up past the unzipped cap are 413 (C1)', () => {
    const chunk = new Uint8Array(400_000)
    const zip = buildZip(['manifest.json', 'board.wirebender.json', 'revisions/000001.json'].map(name => ({ name, method: 0 as const, data: chunk, usize: chunk.length })))
    expect(decodeBundle(zip, { maxUnzipped: 1_000_000 })).toMatchObject({ ok: false, status: 413 })
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
    if (!res.ok) expect(res.error).toBe('manifest.json: unsupported compression')
  })

  it('a deflate entry whose header declares 3 MB is refused on the header alone (I2)', () => {
    const zip = patchSizes(zipSync(good()), 'board.wirebender.json', { originalSize: 3_000_000 })
    const res = decodeBundle(zip)
    expect(res).toMatchObject({ ok: false, status: 413 })
    if (!res.ok) expect(res.error).toContain('board.wirebender.json')
    // Only the 72-byte manifest before it was inflated.
    expect(spy.inflated).toBeLessThan(1000)
  })

  it('an entry that declares more compressed bytes than the zip holds is 422 truncated (C2)', () => {
    const zip = buildZip([{ name: 'manifest.json', method: 8, data: new Uint8Array(10), usize: 10, csize: 1_000_000 }])
    expect(decodeBundle(zip)).toEqual({ ok: false, status: 422, error: 'truncated bundle' })
  })

  it('declared sizes that add up past the unzipped cap are 413 (I2)', () => {
    const res = decodeBundle(zipSync(good()), { maxUnzipped: 1000 })
    expect(res).toMatchObject({ ok: false, status: 413 })
  })

  it('the same entry name twice is 422 naming it (M-a)', () => {
    const b = board()
    const rv = json(rev(1, b))
    const one = deflateSync(rv)
    const zip = buildZip([
      ...Object.entries(good(1)).map(([name, d]) => ({ name, method: 8 as const, data: deflateSync(d), usize: d.length })),
      { name: 'revisions/000001.json', method: 8, data: one, usize: rv.length },
      { name: 'revisions/000001.json', method: 8, data: one, usize: rv.length }
    ])
    const res = decodeBundle(zip)
    expect(res).toEqual({ ok: false, status: 422, error: 'revisions/000001.json: duplicate entry' })
  })

  it('revision and manifest fields are each checked (M-b)', () => {
    const b = board()
    const bad = (name: string, o: object) => decodeBundle(zipSync({ ...good(1), [name]: json({ ...rev(1, b), ...o }) }))
    for (const o of [{ author: 1 }, { how: null }, { summary: 5 }, { target: 1.5 }, { target: 0 }, { n: 1.5 }]) {
      expect(bad('revisions/000001.json', o)).toMatchObject({ ok: false, status: 422 })
    }
    expect(bad('revisions/000000.json', { n: 0 })).toMatchObject({ ok: false, status: 422 })
    expect(decodeBundle(zipSync({ ...good(), 'manifest.json': json({ format: BUNDLE_FORMAT, name: 'x' }) }))).toMatchObject({ ok: false, status: 422 })
    expect(decodeBundle(zipSync({ ...good(), 'manifest.json': json({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 'soon' }) }))).toMatchObject({ ok: false, status: 422 })
  })

  it('exactly MAX_BUNDLE_REVISIONS revisions pass the entry count (M-b)', () => {
    const files: Record<string, Uint8Array> = { ...good(MAX_BUNDLE_REVISIONS) }
    const empty = new Uint8Array(0)
    for (let i = 1; i <= MAX_BUNDLE_REVISIONS; i++) files[`revisions/${String(i).padStart(6, '0')}.json`] = empty
    const zip = zipSync(files, { level: 0 }) // the test's own work, not timed
    const t0 = performance.now()
    const res = decodeBundle(zip)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(res).toMatchObject({ ok: false, status: 422 })
  })

  it('a board with another format is 422 "unsupported bundle format" (I1)', () => {
    const b = board()
    const future = { ...b, format: 'wirebender/2' }
    expect(decodeBundle(zipSync({ ...good(), 'board.wirebender.json': json(future) })))
      .toEqual({ ok: false, status: 422, error: 'unsupported bundle format wirebender/2' })
    const withRev = zipSync({ ...good(1), 'revisions/000001.json': json({ ...rev(1, b), board: future }) })
    expect(decodeBundle(withRev)).toEqual({ ok: false, status: 422, error: 'unsupported bundle format wirebender/2' })
  })

  it('a current board that fails parseBoard is 422 naming board.wirebender.json (I2)', () => {
    const res = decodeBundle(zipSync({ ...good(), 'board.wirebender.json': json({ nope: true }) }))
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error.startsWith('board.wirebender.json:')).toBe(true)
  })

  it('revisions come back sorted by n whatever the zip order (I2)', () => {
    const b = board()
    const res = decodeBundle(zipSync({ ...good(3), 'revisions/000010.json': json(rev(10, b)), 'revisions/000002.json': json(rev(2, b)), 'revisions/000001.json': json(rev(1, b)) }))
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
    const res = decodeBundle(zipSync({ ...good(1), 'revisions/000002.json': json(rev(3, board())) }))
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error.startsWith('revisions/000002.json:')).toBe(true)
  })

  it('a duplicate n is 422 naming the entry (S2)', () => {
    // Two central entries with distinct names cannot share an n under the strict layout, so the name check catches it.
    const b = board()
    const res = decodeBundle(zipSync({ ...good(2), 'revisions/000001.json': json(rev(1, b)), 'revisions/000002.json': json(rev(1, b)) }))
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error.startsWith('revisions/000002.json:')).toBe(true)
  })

  it('a non-finite createdAt, a bad target, or a missing manifest name is 422 (minors)', () => {
    const b = board()
    const raw = (o: object) => strToU8(JSON.stringify({ ...rev(1, b), ...o }).replace('"createdAt":1001', '"createdAt":1e400'))
    expect(decodeBundle(zipSync({ ...good(1), 'revisions/000001.json': raw({}) }))).toMatchObject({ ok: false, status: 422 })
    expect(decodeBundle(zipSync({ ...good(1), 'revisions/000001.json': json({ ...rev(1, b), target: -2.5 }) }))).toMatchObject({ ok: false, status: 422 })
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

  it('the board and revision entries are compact JSON, so a board near the cap fits in its entry (I2)', () => {
    const b = board()
    const files = unzipSync(encodeBundle({ name: 'x', exportedAt: 1, board: b, revisions: [rev(1, b)] }))
    expect(strFromU8(files['board.wirebender.json']!)).toBe(JSON.stringify(b))
    const { n, createdAt, author, how, target, summary } = rev(1, b)
    expect(strFromU8(files['revisions/000001.json']!)).toBe(JSON.stringify({ n, createdAt, author, how, target, summary, board: b }))
  })

  // A pretty-printed bundle, as older code wrote and as people may write by hand.
  const pretty = (b: BoardFile) => {
    const p = (v: unknown) => strToU8(JSON.stringify(v, null, 2))
    return zipSync({
      'manifest.json': p({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 1, revisions: 1 }),
      'board.wirebender.json': strToU8(`${JSON.stringify(b, null, 2)}\n`),
      'revisions/000001.json': p(rev(1, b))
    })
  }

  it('a pretty-printed bundle still decodes (I2)', () => {
    const b = board()
    const res = decodeBundle(pretty(b))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.bundle.revisions[0]).toEqual(rev(1, b))
  })

  it('the board cap measures each board compact, like the server\'s board cap, not the entry bytes (I2)', () => {
    const b = board()
    const compact = strToU8(JSON.stringify(b)).length
    const raw = strToU8(JSON.stringify(rev(1, b), null, 2)).length
    // The pretty entries are over the cap in bytes; their boards are not.
    const cap = Math.ceil(raw / 1.2)
    expect(raw).toBeGreaterThan(cap)
    expect(compact).toBeLessThan(cap)
    expect(decodeBundle(pretty(b), { maxBoardBytes: cap }).ok).toBe(true)
    // One byte under the board's compact size: refused, naming the entry.
    const res = decodeBundle(encodeBundle({ name: 'x', exportedAt: 1, board: b, revisions: [] }), { maxBoardBytes: compact - 1 })
    expect(res).toEqual({ ok: false, status: 413, error: 'board.wirebender.json is too large' })
    expect(decodeBundle(encodeBundle({ name: 'x', exportedAt: 1, board: b, revisions: [] }), { maxBoardBytes: compact }).ok).toBe(true)
  })

  it('a revision whose board is over the cap is 413 naming the revision (I2)', () => {
    const b = board()
    const big: BoardFile = { ...b, nets: { ...b.nets, ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`X${i}`, { class: Object.values(b.nets)[0]!.class }])) } }
    const cap = strToU8(JSON.stringify(big)).length - 1
    const res = decodeBundle(encodeBundle({ name: 'x', exportedAt: 1, board: b, revisions: [rev(1, big)] }), { maxBoardBytes: cap })
    expect(res).toEqual({ ok: false, status: 413, error: 'revisions/000001.json is too large' })
  })

  const full = () => {
    const b = board()
    return encodeBundle({ name: 'x', exportedAt: 1, board: b, revisions: [rev(1, b), rev(2, b), rev(3, b)] })
  }
  const localStart = (zip: Uint8Array, name: string) => {
    const at = strFromU8(zip, true).indexOf(name)
    return at - 30
  }

  it('many directory entries are refused fast (C3)', () => {
    const dirs = Array.from({ length: 150_000 }, (_, i) => ({ name: `d${i}/`, method: 0 as const, data: new Uint8Array(0), usize: 0 }))
    // Only the refusal is timed: building 150 000 entries here is the test's own work.
    const zip = buildZip(dirs)
    const t0 = performance.now()
    const res = decodeBundle(zip)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(res).toMatchObject({ ok: false, status: 422 })
    if (!res.ok) expect(res.error).toBe('d0/: not part of a bundle')
  })

  it('the revisions/ directory entry is allowed (C3)', () => {
    const b = board()
    const entries = [
      { name: 'revisions/', method: 0 as const, data: new Uint8Array(0), usize: 0 },
      ...Object.entries(good(1)).map(([name, d]) => ({ name, method: 8 as const, data: deflateSync(d), usize: d.length, crc: crc32(d) })),
      { name: 'revisions/000001.json', method: 8 as const, data: deflateSync(json(rev(1, b))), usize: json(rev(1, b)).length, crc: crc32(json(rev(1, b))) }
    ]
    expect(decodeBundle(buildZip(entries))).toMatchObject({ ok: true })
  })

  it('a zip cut at an entry boundary is 422, not a short history (I4)', () => {
    const zip = full()
    const res = decodeBundle(zip.subarray(0, localStart(zip, 'revisions/000003.json')))
    expect(res).toMatchObject({ ok: false, status: 422 })
  })

  it('a zip with no end record is 422 (I4)', () => {
    const zip = full()
    expect(decodeBundle(zip.subarray(0, zip.length - 22))).toEqual({ ok: false, status: 422, error: 'truncated bundle' })
  })

  /** Put a zip64 end record and locator before the end record, claiming `count` central entries. */
  function withZip64Count(zip: Uint8Array, count: number): Uint8Array {
    const e = zip.length - 22
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    expect(view.getUint32(e, true)).toBe(0x06054B50)
    const cdOffset = view.getUint32(e + 16, true)
    const out = new Uint8Array(zip.length + 76)
    out.set(zip.subarray(0, e))
    const o = new DataView(out.buffer)
    // zip64 end of central directory record (56 bytes)
    o.setUint32(e, 0x06064B50, true)
    o.setUint32(e + 4, 44, true)
    o.setUint16(e + 12, 45, true)
    o.setUint16(e + 14, 45, true)
    o.setUint32(e + 24, count, true)
    o.setUint32(e + 32, count, true)
    o.setUint32(e + 40, e - cdOffset, true)
    o.setUint32(e + 48, cdOffset, true)
    // zip64 end of central directory locator (20 bytes)
    o.setUint32(e + 56, 0x07064B50, true)
    o.setUint32(e + 64, e, true)
    o.setUint32(e + 72, 1, true)
    out.set(zip.subarray(e), e + 76)
    return out
  }

  it('a zip64 end record that claims 100M entries is refused fast (C4)', () => {
    const zip = full()
    expect(decodeBundle(withZip64Count(zip, 5))).toMatchObject({ ok: true })
    const t0 = performance.now()
    const res = decodeBundle(withZip64Count(zip, 100_000_000))
    expect(performance.now() - t0).toBeLessThan(100)
    expect(res).toEqual({ ok: false, status: 422, error: 'central directory does not match the entries' })
  })

  it('a cut inside an entry is 422 "truncated bundle" (I4, M-e)', () => {
    const zip = full()
    const res = decodeBundle(zip.subarray(0, localStart(zip, 'revisions/000003.json') + 60))
    expect(res).toEqual({ ok: false, status: 422, error: 'truncated bundle' })
  })

  it('a central directory that lists fewer entries than the local headers is 422 (I4)', () => {
    const b = board()
    const rv = json(rev(1, b))
    const entries = [
      ...Object.entries(good(1)).map(([name, d]) => ({ name, method: 8 as const, data: deflateSync(d), usize: d.length, crc: crc32(d) })),
      { name: 'revisions/000001.json', method: 8 as const, data: deflateSync(rv), usize: rv.length, crc: crc32(rv) }
    ]
    expect(decodeBundle(buildZip(entries))).toMatchObject({ ok: true })
    expect(decodeBundle(buildZip(entries, false, 2))).toEqual({ ok: false, status: 422, error: 'central directory does not match the entries' })
  })

  it('a manifest revisions count that differs from the files is 422 (M7)', () => {
    const b = board()
    const res = decodeBundle(zipSync({ ...good(3), 'revisions/000001.json': json(rev(1, b)) }))
    expect(res).toEqual({ ok: false, status: 422, error: 'manifest.json: revisions does not match the bundle' })
  })

  it('a corrupt deflate stream in a revision is 422 naming it (M-d)', () => {
    const entries = [
      ...Object.entries(good(1)).map(([name, d]) => ({ name, method: 8 as const, data: deflateSync(d), usize: d.length })),
      { name: 'revisions/000001.json', method: 8 as const, data: new Uint8Array(20).fill(0xFF), usize: 500 }
    ]
    expect(decodeBundle(buildZip(entries))).toEqual({ ok: false, status: 422, error: 'revisions/000001.json: could not be unzipped' })
  })
})

describe('checksums', () => {
  it('crc32 is the zip CRC-32', () => {
    expect(crc32(strToU8('123456789'))).toBe(0xCBF43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('a file changed inside the zip (still valid JSON) is refused, naming it', () => {
    const b = board()
    const zip = zipSync({ 'manifest.json': json({ format: BUNDLE_FORMAT, name: 'x', exportedAt: 1, revisions: 0 }), 'board.wirebender.json': json({ ...b, name: 'AAAA' }) }, { level: 0 })
    expect(decodeBundle(zip)).toMatchObject({ ok: true })
    const at = strFromU8(zip, true).indexOf('"AAAA"')
    const damaged = zip.slice()
    damaged[at + 1] = 'B'.charCodeAt(0)
    expect(decodeBundle(damaged)).toEqual({ ok: false, status: 422, error: 'This bundle is damaged: board.wirebender.json does not match its checksum.' })
  })

  it('a bundle WireBender wrote passes', () => {
    const b = board()
    expect(decodeBundle(encodeBundle({ name: 'x', exportedAt: 1, board: b, revisions: [rev(1, b)] }))).toMatchObject({ ok: true })
  })
})
