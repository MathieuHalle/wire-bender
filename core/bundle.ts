import { Unzip, UnzipInflate, UnzipPassThrough, unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { crc32 } from './crc32'
import { parseBoard, type BoardFile } from './schema'

export const BUNDLE_FORMAT = 'wirebender-bundle/1'
export const MAX_BUNDLE_BYTES = 50_000_000
export const MAX_BUNDLE_UNZIPPED = 200_000_000
export const MAX_BUNDLE_REVISIONS = 20_000
/** Per-board cap. The server passes its own `MAX_BOARD_BYTES` (also 2 000 000) as `maxBoardBytes`. */
const DEFAULT_MAX_BOARD_BYTES = 2_000_000
/**
 * An entry's raw bytes may be up to this times `maxBoardBytes` (2.4 MB for the server). The board cap itself is on
 * each parsed board's compact JSON, the measure the server's board cap uses; this bound only keeps the memory and
 * inflate work per entry bounded. 1.2 leaves room for a revision's own fields beside a board at the cap, and lets a
 * pretty-printed (older or hand-made) entry through while its board is under about 1.1 MB (0.95 MB before).
 */
const RAW_ENTRY_FACTOR = 1.2

export interface BundleRevision {
  n: number
  createdAt: number
  author: string
  how: string
  target: number | null
  summary: string
  board: BoardFile
}

export interface Bundle {
  name: string
  exportedAt: number
  board: BoardFile
  revisions: BundleRevision[]
}

export type DecodeResult = { ok: true, bundle: Bundle } | { ok: false, status: 413 | 422, error: string }

const BOARD_FORMAT = 'wirebender/1'
const BOARD_ENTRY = 'board.wirebender.json'
const revisionPath = (n: number) => `revisions/${String(n).padStart(6, '0')}.json`

/** Compact JSON (I2): an entry then weighs about what its board does, so a board at the server's cap fits. */
const compact = (v: unknown) => strToU8(JSON.stringify(v))

export function encodeBundle(b: Bundle): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ format: BUNDLE_FORMAT, name: b.name, exportedAt: b.exportedAt, revisions: b.revisions.length }, null, 2)),
    [BOARD_ENTRY]: compact(b.board)
  }
  for (const r of b.revisions) {
    const { n, createdAt, author, how, target, summary, board } = r
    files[revisionPath(n)] = compact({ n, createdAt, author, how, target, summary, board })
  }
  return zipSync(files)
}

class Refused extends Error {
  constructor(readonly status: 413 | 422, message: string) { super(message) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** An entry name for an error message: no control characters, and short. */
// eslint-disable-next-line no-control-regex
const shown = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 100)

const REVISION_PATH = /^revisions\/(\d{6})\.json$/

function parseEntry(path: string, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes))
  } catch {
    throw new Refused(422, `${path}: not valid JSON`)
  }
}

/** The entry's board, parsed, and no larger in compact JSON than `maxBoardBytes` (413 naming the entry). */
function boardOf(path: string, value: unknown, maxBoardBytes: number): BoardFile {
  if (isRecord(value) && typeof value.format === 'string' && value.format !== BOARD_FORMAT) throw new Refused(422, `unsupported bundle format ${String(value.format)}`)
  const res = parseBoard(value)
  if (!res.ok) throw new Refused(422, `${path}: ${res.errors[0] ?? 'not a valid board'}`)
  if (compact(res.board).length > maxBoardBytes) throw new Refused(413, `${path} is too large`)
  return res.board
}

const SLICE = 16 * 1024

/**
 * Unzips with fflate's streaming reader instead of `unzipSync`: `unzipSync` keeps inflating a deflate entry past its
 * declared size, so its CPU cost is not bounded by any header. Here the zip goes in 16 KB slices, every output byte is
 * counted as it arrives, and the first entry or total over a cap stops the work, so a slice's expansion is the most
 * that is ever wasted. Entries are read from their local headers in order, so overlapping central entries are not replayed.
 * Every local header is counted first (fflate's reader is quadratic in them), and afterwards the central directory is
 * read without inflating anything and must list exactly the streamed entries, so a cut zip is never a short history.
 */
function inflateAll(zip: Uint8Array, maxEntryBytes: number, maxUnzipped: number): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const seen = new Set<string>()
  let refusal: Refused | null = null
  let total = 0
  let headers = 0
  let revisionFiles = 0
  const refuse = (status: 413 | 422, msg: string) => {
    refusal ??= new Refused(status, msg)
  }

  const unzip = new Unzip((file) => {
    if (refusal) return
    if (++headers > MAX_BUNDLE_REVISIONS + 3) return refuse(413, 'bundle has too many entries')
    const name = shown(file.name)
    const isDir = file.name === 'revisions/'
    if (file.name !== 'manifest.json' && file.name !== BOARD_ENTRY && !isDir && !REVISION_PATH.test(file.name)) return refuse(422, `${name}: not part of a bundle`)
    if (seen.has(file.name)) return refuse(422, `${name}: duplicate entry`)
    seen.add(file.name)
    if (isDir) return
    if (REVISION_PATH.test(file.name) && ++revisionFiles > MAX_BUNDLE_REVISIONS) return refuse(413, 'bundle has too many revisions')
    if (file.compression !== 0 && file.compression !== 8) return refuse(422, `${name}: unsupported compression`)
    // The sizes are unknown (undefined) for an entry that uses a data descriptor. The counting below covers that case.
    if (file.size !== undefined && file.originalSize !== undefined) {
      if (file.compression === 0 && file.size !== file.originalSize) return refuse(422, `${name}: sizes do not match`)
      if (Math.max(file.size, file.originalSize) > maxEntryBytes) return refuse(413, `${name} is too large`)
    }
    const chunks: Uint8Array[] = []
    let length = 0
    file.ondata = (err, data, final) => {
      if (refusal) return
      if (err) return refuse(422, `${name}: could not be unzipped`)
      length += data.length
      total += data.length
      if (length > maxEntryBytes) {
        file.terminate()
        return refuse(413, `${name} is too large`)
      }
      if (total > maxUnzipped) {
        file.terminate()
        return refuse(413, 'bundle is too large when unzipped')
      }
      chunks.push(data)
      if (!final) return
      const bytes = new Uint8Array(length)
      let at = 0
      for (const c of chunks) {
        bytes.set(c, at)
        at += c.length
      }
      files.set(file.name, bytes)
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  unzip.register(UnzipPassThrough)

  try {
    for (let at = 0; at < zip.length && !refusal; at += SLICE) {
      unzip.push(zip.subarray(at, at + SLICE), at + SLICE >= zip.length)
    }
  } catch {
    // fflate throws when the zip ends inside an entry.
    throw refusal ?? new Refused(422, 'truncated bundle')
  }
  if (refusal) throw refusal
  if (seen.size === 0) throw new Refused(422, 'not a zip file')

  // The central directory, read without inflating (the filter refuses every entry). A missing end record throws.
  // fflate loops for as many entries as the end record claims (a zip64 one can claim billions), so the walk stops as
  // soon as it passes the number of streamed entries (`seen` includes the `revisions/` directory entry).
  const central: string[] = []
  let count = 0
  try {
    unzipSync(zip, {
      filter: (f) => {
        if (++count > seen.size) throw new Refused(422, 'central directory does not match the entries')
        if (!f.name.endsWith('/')) central.push(f.name)
        return false
      }
    })
  } catch (e) {
    throw e instanceof Refused ? e : new Refused(422, 'truncated bundle')
  }
  const local = [...seen].filter(n => !n.endsWith('/')).sort()
  if (central.sort().join('\n') !== local.join('\n')) throw new Refused(422, 'central directory does not match the entries')
  // fflate checks no checksum: each file's CRC-32 must match the one the central directory holds.
  const crcs = centralCrcs(zip, seen.size)
  for (const [name, bytes] of files) {
    if (crcs.get(name) !== crc32(bytes)) throw new Refused(422, `This bundle is damaged: ${shown(name)} does not match its checksum.`)
  }
  return files
}

const u16At = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u32At = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0

/**
 * Each entry's CRC-32 from the central directory, by name. Called after fflate read the same
 * directory, so the end record exists; at most `max` entries are read. A record that does
 * not fit is a truncated bundle.
 */
function centralCrcs(zip: Uint8Array, max: number): Map<string, number> {
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xFFFF); at--) {
    if (u32At(zip, at) === 0x06054B50) {
      end = at
      break
    }
  }
  if (end < 0) throw new Refused(422, 'truncated bundle')
  const count = Math.min(u16At(zip, end + 10), max)
  const crcs = new Map<string, number>()
  let at = u32At(zip, end + 16)
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || u32At(zip, at) !== 0x02014B50) throw new Refused(422, 'truncated bundle')
    const nameLength = u16At(zip, at + 28)
    const next = at + 46 + nameLength + u16At(zip, at + 30) + u16At(zip, at + 32)
    if (next > zip.length) throw new Refused(422, 'truncated bundle')
    crcs.set(strFromU8(zip.subarray(at + 46, at + 46 + nameLength)), u32At(zip, at + 16))
    at = next
  }
  return crcs
}

/**
 * The server passes its `MAX_BOARD_BYTES` as `maxBoardBytes`: each board (the current one and every revision's), in
 * compact JSON, may be that large. `maxUnzipped` is for tests. Pretty-printed entries decode too.
 */
export function decodeBundle(zip: Uint8Array, opts: { maxBoardBytes?: number, maxUnzipped?: number } = {}): DecodeResult {
  const maxBoardBytes = opts.maxBoardBytes ?? DEFAULT_MAX_BOARD_BYTES
  const maxUnzipped = opts.maxUnzipped ?? MAX_BUNDLE_UNZIPPED
  if (zip.length > MAX_BUNDLE_BYTES) return { ok: false, status: 413, error: 'bundle is too large' }
  try {
    const files = inflateAll(zip, Math.floor(maxBoardBytes * RAW_ENTRY_FACTOR), maxUnzipped)

    const manifest = files.get('manifest.json')
    if (!manifest) throw new Refused(422, 'bundle has no manifest.json')
    const m = parseEntry('manifest.json', manifest)
    if (!isRecord(m)) throw new Refused(422, 'manifest.json: not an object')
    if (m.format !== BUNDLE_FORMAT) throw new Refused(422, `unsupported bundle format ${String(m.format)}`)
    if (typeof m.name !== 'string') throw new Refused(422, 'manifest.json: name must be a string')
    if (typeof m.exportedAt !== 'number' || !Number.isFinite(m.exportedAt)) throw new Refused(422, 'manifest.json: exportedAt must be a number')

    const boardBytes = files.get(BOARD_ENTRY)
    if (!boardBytes) throw new Refused(422, `bundle has no ${BOARD_ENTRY}`)
    const board = boardOf(BOARD_ENTRY, parseEntry(BOARD_ENTRY, boardBytes), maxBoardBytes)

    const revisions: BundleRevision[] = []
    for (const [path, bytes] of files) {
      const match = REVISION_PATH.exec(path)
      if (!match) continue
      const r = parseEntry(path, bytes)
      if (!isRecord(r)) throw new Refused(422, `${path}: not an object`)
      if (typeof r.n !== 'number' || !Number.isInteger(r.n) || r.n < 1) throw new Refused(422, `${path}: n must be a positive integer`)
      if (r.n !== Number(match[1])) throw new Refused(422, `${path}: n does not match the file name`)
      if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) throw new Refused(422, `${path}: createdAt must be a number`)
      if (typeof r.author !== 'string') throw new Refused(422, `${path}: author must be a string`)
      if (typeof r.how !== 'string') throw new Refused(422, `${path}: how must be a string`)
      if (r.target !== null && (typeof r.target !== 'number' || !Number.isInteger(r.target) || r.target < 1)) throw new Refused(422, `${path}: target must be a revision number or null`)
      if (typeof r.summary !== 'string') throw new Refused(422, `${path}: summary must be a string`)
      revisions.push({ n: r.n, createdAt: r.createdAt, author: r.author, how: r.how, target: r.target, summary: r.summary, board: boardOf(path, r.board, maxBoardBytes) })
    }
    // The file name equals n, so n is unique; sort so the order does not depend on the zip.
    revisions.sort((a, b) => a.n - b.n)
    if (m.revisions !== revisions.length) throw new Refused(422, 'manifest.json: revisions does not match the bundle')

    return { ok: true, bundle: { name: m.name, exportedAt: m.exportedAt, board, revisions } }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, status: e.status, error: e.message }
    throw e
  }
}
