import { createHash } from 'node:crypto'
import { runCheck } from '~core/check'
import { parseBoard, type BoardFile } from '~core/schema'
import { statsLine, ADVISORY } from '../../cli/format'
import { tickKey } from '../../export/benchHtml'
import type { Db } from '../db'
import { benchResponse, fileStem } from './bench'
import { createBoard, getBoard, getRevision, listBoards, listRevisions } from './boards'
import { openRoom, type Room } from './rooms'

/** The largest request body, in bytes, that the API accepts. */
export const MAX_BOARD_BYTES = 2_000_000

/** API writes are by the one local user in step 1. */
const AUTHOR = 'Local'
const HOW = 'api'

export interface ApiResult {
  status: number
  body: unknown
  /** Response headers to set; `body` is then sent as is (a string). */
  headers?: Record<string, string>
}

const ok = (body: unknown, headers?: Record<string, string>): ApiResult => ({ status: 200, body, headers })
const notFound = (): ApiResult => ({ status: 404, body: { error: 'not found' } })
const invalid = (...errors: string[]): ApiResult => ({ status: 422, body: { errors } })

type Parsed = { ok: true, json: Record<string, unknown> } | { ok: false, result: ApiResult }

/** A request body as a JSON object, or the 413 / 422 to answer with. The size is checked before parsing. */
function parseBody(text: string): Parsed {
  if (Buffer.byteLength(text) > MAX_BOARD_BYTES) return { ok: false, result: { status: 413, body: { error: `body is larger than ${MAX_BOARD_BYTES} bytes` } } }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, result: invalid(`not valid JSON: ${(e as Error).message}`) }
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, result: invalid('the body must be a JSON object') }
  return { ok: true, json: json as Record<string, unknown> }
}

/** An empty `wirebender/1` board from `{ name, cols, rows, type }`; parseBoard rejects bad values. */
function emptyBoard(json: Record<string, unknown>): unknown {
  return {
    format: 'wirebender/1',
    revision: 0,
    name: json.name,
    board: { cols: json.cols, rows: json.rows, pitchMm: 2.54, type: json.type, blocked: [] },
    netClasses: {},
    nets: {},
    rules: { keepAway: [], adjacency: [] },
    parts: [],
    trails: [],
    wires: [],
    legFolds: [],
    solderBridges: []
  }
}

/** `POST /api/boards`: `{ board }` imports, `{ name, cols, rows, type }` creates an empty board. */
export function createOrImport(db: Db, text: string): ApiResult {
  const p = parseBody(text)
  if (!p.ok) return p.result
  const { json } = p
  const importing = 'board' in json
  if (!importing && (typeof json.name !== 'string' || json.name.trim() === '')) return invalid('name: must be a non-empty string')
  const parsed = parseBoard(importing ? json.board : emptyBoard(json))
  if (!parsed.ok) return invalid(...parsed.errors)
  return ok({ id: createBoard(db, parsed.board, importing ? 'import' : 'create', AUTHOR).id })
}

export function listBoardsResponse(db: Db): ApiResult {
  return ok(listBoards(db))
}

export function getBoardResponse(db: Db, id: string): ApiResult {
  return foundOr404(getBoard(db, id))
}

function foundOr404(body: unknown): ApiResult {
  return body === null ? notFound() : ok(body)
}

/** Run `fn` on the board's live room; 404 when there is no such board. Never keeps the room. */
function withRoom(db: Db, id: string, fn: (room: Room) => ApiResult): ApiResult {
  const room = openRoom(db, id)
  return room ? fn(room) : notFound()
}

/** `PUT /api/boards/:id`: `{ board, baseRevision? }`. */
export function putBoard(db: Db, id: string, text: string): ApiResult {
  const p = parseBody(text)
  if (!p.ok) return p.result
  const { board, baseRevision } = p.json
  if (baseRevision !== undefined && !Number.isInteger(baseRevision)) return invalid('baseRevision must be an integer')
  const parsed = parseBoard(board)
  if (!parsed.ok) return invalid(...parsed.errors)
  return withRoom(db, id, (room) => {
    const head = getBoard(db, id)!.head
    if (baseRevision !== undefined && baseRevision !== head) return { status: 409, body: { current: head } }
    return ok({ revision: room.serverWrite(parsed.board, { author: AUTHOR, how: HOW }) })
  })
}

/** `PATCH /api/boards/:id`: `{ name }`, a board change like any other. */
export function renameBoard(db: Db, id: string, text: string): ApiResult {
  const p = parseBody(text)
  if (!p.ok) return p.result
  const name = typeof p.json.name === 'string' ? p.json.name.trim() : ''
  if (name === '') return invalid('name: must be a non-empty string')
  return withRoom(db, id, (room) => {
    const current = getBoard(db, id)!.board
    return ok({ revision: room.serverWrite({ ...current, name }, { author: AUTHOR, how: HOW }) })
  })
}

export function checkBoard(db: Db, id: string): ApiResult {
  const stored = getBoard(db, id)
  if (!stored) return notFound()
  const result = runCheck(stored.board)
  return ok({ ...result, statsLine: statsLine(result.stats), advisory: ADVISORY })
}

export function benchBoard(db: Db, id: string, date?: string): ApiResult {
  const stored = getBoard(db, id)
  if (!stored) return notFound()
  const hash = tickKey(createHash('sha256').update(`${stored.id}:${stored.head}`).digest('hex'))
  const r = benchResponse(stored.board, hash, date)
  return ok(r.body, r.headers)
}

export function downloadBoard(db: Db, id: string): ApiResult {
  const stored = getBoard(db, id)
  if (!stored) return notFound()
  const filename = `${fileStem(stored.name)}.wirebender.json`
  return ok(`${JSON.stringify(stored.board, null, 2)}\n`, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename="${filename}"`
  })
}

function change(db: Db, id: string, step: (room: Room) => number | null, reason: string): ApiResult {
  return withRoom(db, id, (room) => {
    const revision = step(room)
    return revision === null ? { status: 409, body: { reason } } : ok({ revision })
  })
}

export const undoBoard = (db: Db, id: string): ApiResult => change(db, id, r => r.undo(AUTHOR), 'nothing to undo')
export const redoBoard = (db: Db, id: string): ApiResult => change(db, id, r => r.redo(AUTHOR), 'nothing to redo')

export function listRevisionsResponse(db: Db, id: string): ApiResult {
  return getBoard(db, id) ? ok(listRevisions(db, id)) : notFound()
}

/** A revision number from a URL segment, or `null` if it is not a positive integer. */
function revisionNumber(segment: string): number | null {
  return /^[1-9]\d{0,9}$/.test(segment) ? Number(segment) : null
}

export function getRevisionResponse(db: Db, id: string, segment: string): ApiResult {
  const n = revisionNumber(segment)
  return foundOr404(n === null ? null : getRevision(db, id, n)?.board ?? null)
}

export function restoreRevision(db: Db, id: string, segment: string): ApiResult {
  const n = revisionNumber(segment)
  const rev = n === null ? null : getRevision(db, id, n)
  if (n === null || !rev) return notFound()
  return withRoom(db, id, room => ok({ revision: room.serverWrite(rev.board as BoardFile, { author: AUTHOR, how: 'restore', target: n }) }))
}
