import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { parseBoard, type BoardFile } from './schema'

export const BUNDLE_FORMAT = 'wirebender-bundle/1'
export const MAX_BUNDLE_BYTES = 50_000_000
export const MAX_BUNDLE_UNZIPPED = 200_000_000
export const MAX_BUNDLE_REVISIONS = 20_000
/** Per-entry cap. The server passes its own `MAX_BOARD_BYTES` (also 2 000 000) as `maxBoardBytes`. */
const DEFAULT_MAX_BOARD_BYTES = 2_000_000

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

const BOARD_ENTRY = 'board.wirebender.json'
const revisionPath = (n: number) => `revisions/${String(n).padStart(6, '0')}.json`

/** The same formatting as the board download route (`downloadBoard` in server/utils/api.ts). */
const boardJson = (b: BoardFile) => `${JSON.stringify(b, null, 2)}\n`

export function encodeBundle(b: Bundle): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ format: BUNDLE_FORMAT, name: b.name, exportedAt: b.exportedAt, revisions: b.revisions.length }, null, 2)),
    [BOARD_ENTRY]: strToU8(boardJson(b.board))
  }
  for (const r of b.revisions) {
    const { n, createdAt, author, how, target, summary, board } = r
    files[revisionPath(n)] = strToU8(JSON.stringify({ n, createdAt, author, how, target, summary, board }, null, 2))
  }
  return zipSync(files)
}

class Refused extends Error {
  constructor(readonly status: 413 | 422, message: string) { super(message) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseEntry(path: string, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes))
  } catch {
    throw new Refused(422, `${path}: not valid JSON`)
  }
}

function boardOf(path: string, value: unknown): BoardFile {
  const res = parseBoard(value)
  if (!res.ok) throw new Refused(422, `${path}: ${res.errors[0] ?? 'not a valid board'}`)
  return res.board
}

export function decodeBundle(zip: Uint8Array, opts: { maxBoardBytes?: number } = {}): DecodeResult {
  const maxBoardBytes = opts.maxBoardBytes ?? DEFAULT_MAX_BOARD_BYTES
  if (zip.length > MAX_BUNDLE_BYTES) return { ok: false, status: 413, error: 'bundle is too large' }
  try {
    let total = 0
    let revisionCount = 0
    const refusal: { value: Refused | null } = { value: null }
    const refuse = (status: 413 | 422, msg: string) => {
      refusal.value ??= new Refused(status, msg)
      return false
    }
    let files: Record<string, Uint8Array> = {}
    try {
      files = unzipSync(zip, {
        // Runs before an entry is inflated, so a zip bomb is refused on its declared size.
        filter: (f) => {
          if (refusal.value) return false
          if (f.name.endsWith('/')) return false
          if (f.originalSize > maxBoardBytes) return refuse(413, `${f.name} is too large`)
          total += f.originalSize
          if (total > MAX_BUNDLE_UNZIPPED) return refuse(413, 'bundle is too large when unzipped')
          if (f.name.startsWith('revisions/') && ++revisionCount > MAX_BUNDLE_REVISIONS) return refuse(413, 'bundle has too many revisions')
          return true
        }
      })
    } catch {
      throw refusal.value ?? new Refused(422, 'not a zip file')
    }
    if (refusal.value) throw refusal.value
    // An entry may inflate to more than it declared.
    for (const [name, bytes] of Object.entries(files)) {
      if (bytes.length > maxBoardBytes) throw new Refused(413, `${name} is too large`)
    }

    const manifest = files['manifest.json']
    if (!manifest) throw new Refused(422, 'bundle has no manifest.json')
    const m = parseEntry('manifest.json', manifest)
    if (!isRecord(m)) throw new Refused(422, 'manifest.json: not an object')
    if (m.format !== BUNDLE_FORMAT) throw new Refused(422, `unsupported bundle format ${String(m.format)}`)

    const boardBytes = files[BOARD_ENTRY]
    if (!boardBytes) throw new Refused(422, `bundle has no ${BOARD_ENTRY}`)
    const board = boardOf(BOARD_ENTRY, parseEntry(BOARD_ENTRY, boardBytes))

    const revisions: BundleRevision[] = []
    for (const path of Object.keys(files).filter(p => p.startsWith('revisions/') && p.endsWith('.json')).sort()) {
      const r = parseEntry(path, files[path]!)
      if (!isRecord(r)) throw new Refused(422, `${path}: not an object`)
      if (typeof r.n !== 'number' || !Number.isInteger(r.n) || r.n < 1) throw new Refused(422, `${path}: n must be a positive integer`)
      if (typeof r.createdAt !== 'number') throw new Refused(422, `${path}: createdAt must be a number`)
      if (typeof r.author !== 'string') throw new Refused(422, `${path}: author must be a string`)
      if (typeof r.how !== 'string') throw new Refused(422, `${path}: how must be a string`)
      if (r.target !== null && typeof r.target !== 'number') throw new Refused(422, `${path}: target must be a number or null`)
      if (typeof r.summary !== 'string') throw new Refused(422, `${path}: summary must be a string`)
      revisions.push({ n: r.n, createdAt: r.createdAt, author: r.author, how: r.how, target: r.target, summary: r.summary, board: boardOf(path, r.board) })
    }
    revisions.sort((a, b) => a.n - b.n)

    const name = typeof m.name === 'string' ? m.name : ''
    const exportedAt = typeof m.exportedAt === 'number' ? m.exportedAt : 0
    return { ok: true, bundle: { name, exportedAt, board, revisions } }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, status: e.status, error: e.message }
    throw e
  }
}
