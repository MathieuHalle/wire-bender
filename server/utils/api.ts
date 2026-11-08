import { createHash } from 'node:crypto'
import { runCheck } from '~core/check'
import { parseBoard, type BoardFile } from '~core/schema'
import { parseFlip } from '~core/sideView'
import { statsLine, ADVISORY } from '../../cli/format'
import { tickKey } from '../../export/benchHtml'
import type { Db } from '../db'
import { benchResponse, fileStem } from './bench'
import { access, allows, ownerName, recordVisit, type Access, type Role } from './boardAccess'
import { boardOverviewSvg } from '../../export/svg'
import { MAX_BOARD_BYTES, createBoard, getBoard, getBoardRow, getRevision, listBoards, listRevisions, listShared } from './boards'
import { openRoom, type Room } from './rooms'
import { authorIdOf, type Who } from './who'

/** The largest request body, in bytes, that the API accepts (also the live board's cap). */

/** The author of a create or import when a caller passes none (tests); routes pass the request's. */
const AUTHOR = 'Local'
const HOW = 'api'

export interface ApiResult {
  status: number
  body: unknown
  /** Response headers to set; `body` is then sent as is (a string). */
  headers?: Record<string, string>
}

const ok = (body: unknown, headers?: Record<string, string>): ApiResult => ({ status: 200, body, headers })
export const notFound = (): ApiResult => ({ status: 404, body: { error: 'not found' } })
export const invalid = (...errors: string[]): ApiResult => ({ status: 422, body: { errors } })

/** A body over `max` bytes (MAX_BOARD_BYTES unless a route caps it lower). */
export const tooLarge = (max = MAX_BOARD_BYTES): ApiResult => ({ status: 413, body: { error: `body is larger than ${max} bytes` } })

type Parsed = { ok: true, json: Record<string, unknown> } | { ok: false, result: ApiResult }

/** A request body as a JSON object, or the 413 / 422 to answer with. The size is checked before parsing. */
export function parseBody(text: string): Parsed {
  if (Buffer.byteLength(text) > MAX_BOARD_BYTES) return { ok: false, result: tooLarge() }
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

/** `POST /api/boards`: `{ board }` imports, `{ name, cols, rows, type }` creates an empty board, owned by `ownerId`. */
export function createOrImport(db: Db, text: string, author = AUTHOR, ownerId = 'local'): ApiResult {
  const p = parseBody(text)
  if (!p.ok) return p.result
  const { json } = p
  const importing = 'board' in json
  if (!importing && (typeof json.name !== 'string' || json.name.trim() === '')) return invalid('name: must be a non-empty string')
  const parsed = parseBoard(importing ? json.board : emptyBoard(json))
  if (!parsed.ok) return invalid(...parsed.errors)
  return ok({ id: createBoard(db, parsed.board, importing ? 'import' : 'create', author, ownerId, ownerId).id })
}

/** `GET /api/boards?list=`: `userId`'s own boards (`mine`, the default), those in their `trash`, or the boards `shared` with them. */
export function listBoardsResponse(db: Db, userId = 'local', list: unknown = 'mine'): ApiResult {
  if (list === 'mine' || list === 'trash') return ok(listBoards(db, userId, list))
  if (list === 'shared') return ok(listShared(db, userId))
  return invalid('list: must be mine, shared or trash')
}

/**
 * Which board a route is asked about, and by whom: `key` is the board id or its share link
 * id, `unlocked` the link ids whose password the session has entered.
 */
export interface BoardRequest { key: string, who: Who, unlocked?: readonly string[] }

type Granted = Access & { ok: true }

/**
 * The access step every board route takes: `fn` runs on the board `req` names only if the
 * asker's role allows `need`. Otherwise the same 404 as an unknown board, 401
 * `{ password: true }` for a link whose password the session has not entered, or 403 for a
 * signed-out visitor on an edit link asking to edit.
 */
export function withAccess<R>(db: Db, req: BoardRequest, need: Role, fn: (a: Granted) => R): R | ApiResult {
  const a = access(db, req.who, req.key, req.unlocked ?? [])
  return refusalOf(a, need) ?? fn(a as Granted)
}

/** What to answer for access `a` when `need` is asked for; null when it is allowed. */
function refusalOf(a: Access, need: Role): ApiResult | null {
  if (!a.ok) return a.status === 401 ? { status: 401, body: { password: true } } : notFound()
  if (allows(a.role, need)) return null
  return a.signInToEdit && need === 'edit' ? { status: 403, body: { error: 'Sign in to edit.' } } : notFound()
}

/**
 * An owner-only route's access step: every refusal (unknown, someone else's, a link, a link
 * whose password is or isn't entered) is the plain 404 of an unknown board.
 */
export function withOwner<R>(db: Db, req: BoardRequest, fn: (a: Granted) => R): R | ApiResult {
  const a = access(db, req.who, req.key, req.unlocked ?? [])
  return a.ok && a.role === 'owner' ? fn(a) : notFound()
}

/** The owner-only access step alone, before a body is read: the plain 404, or null. */
export const ownerRefusal = (db: Db, req: BoardRequest): ApiResult | null => withOwner(db, req, () => null)

/** The access step alone, for a route that must refuse before it reads a body. */
export const accessRefusal = (db: Db, req: BoardRequest, need: Role): ApiResult | null =>
  refusalOf(access(db, req.who, req.key, req.unlocked ?? []), need)

/** Before a PUT's body is read: its refusal, or null. `putBoard` checks again. */
export const putRefusal = (db: Db, req: BoardRequest): ApiResult | null => accessRefusal(db, req, 'edit')
/** Before a PATCH's body is read: its refusal, or null. `renameBoard` checks again. */
export const renameRefusal = ownerRefusal

/** Who a board change is by. Only the owner or a signed-in editor gets this far. */
const authorOf = (who: Who): string => who.kind === 'anonymous' ? AUTHOR : who.author

/** `GET /api/boards/:key`: to anyone but the owner by board id, `id` is the key they used. */
export function getBoardResponse(db: Db, req: BoardRequest): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const stored = getBoard(db, a.boardId)
    if (!stored) return notFound()
    recordVisit(db, req.who, a, req.key)
    return ok({
      ...stored,
      id: a.viaLink ? req.key : a.boardId,
      role: a.role,
      signInToEdit: a.signInToEdit,
      owner: { name: ownerName(db, a.boardId) },
      forkedFrom: a.role === 'owner' ? forkedFrom(db, req, a.boardId) : null
    })
  })
}

/**
 * Where the owner's board was forked from, as they may reach it now: their own board by its
 * id, someone else's by the link the fork was made through, and only while that is still
 * the source's link (R12: a regenerate kills the old link for forkers too, and the new one
 * is never handed out); null if it is gone, trashed, or no longer viewable by them
 * (private, its owner deleted, a password they haven't entered).
 */
function forkedFrom(db: Db, req: BoardRequest, boardId: string): { key: string, name: string } | null {
  const fork = getBoardRow(db, boardId)
  const source = fork?.forkedFrom ? getBoardRow(db, fork.forkedFrom) : undefined
  if (!fork || !source || source.trashedAt !== null) return null
  const own = access(db, req.who, source.id, [])
  if (own.ok) return { key: source.id, name: source.name }
  const link = fork.forkedFromLink
  if (link === null || link !== source.linkId) return null
  return access(db, req.who, link, req.unlocked ?? []).ok ? { key: link, name: source.name } : null
}

function foundOr404(body: unknown): ApiResult {
  return body === null ? notFound() : ok(body)
}

/** Run `fn` on the board's live room; 404 when there is no such board. Never keeps the room. */
function withRoom(db: Db, id: string, fn: (room: Room) => ApiResult): ApiResult {
  const room = openRoom(db, id)
  return room ? fn(room) : notFound()
}

/** `PUT /api/boards/:key`: `{ board, baseRevision? }`. A non-owner's board keeps its current name. */
export function putBoard(db: Db, req: BoardRequest, text: string): ApiResult {
  return withAccess(db, req, 'edit', (a) => {
    const p = parseBody(text)
    if (!p.ok) return p.result
    const { board, baseRevision } = p.json
    if (baseRevision !== undefined && !Number.isInteger(baseRevision)) return invalid('baseRevision must be an integer')
    const parsed = parseBoard(board)
    if (!parsed.ok) return invalid(...parsed.errors)
    return withRoom(db, a.boardId, (room) => {
      // Commit live edits still grouping first: they are part of the board the base is checked against.
      const head = room.flush()
      if (baseRevision !== undefined && baseRevision !== head) {
        room.dropIfEmpty()
        return { status: 409, body: { current: head } }
      }
      // Only the owner renames (spec §5): anyone else's board keeps the name it has now.
      const next = a.role === 'owner' ? parsed.board : { ...parsed.board, name: getBoard(db, a.boardId)!.board.name }
      return ok({ revision: room.serverWrite(next, { author: authorOf(req.who), how: HOW, authorId: authorIdOf(req.who) }) })
    })
  })
}

/** `PATCH /api/boards/:id`: `{ name }`, a board change like any other; the owner's only. */
export function renameBoard(db: Db, req: BoardRequest, text: string): ApiResult {
  return withOwner(db, req, (a) => {
    const p = parseBody(text)
    if (!p.ok) return p.result
    const name = typeof p.json.name === 'string' ? p.json.name.trim() : ''
    if (name === '') return invalid('name: must be a non-empty string')
    return withRoom(db, a.boardId, (room) => {
      const current = getBoard(db, a.boardId)!.board
      return ok({ revision: room.serverWrite({ ...current, name }, { author: authorOf(req.who), how: HOW, authorId: authorIdOf(req.who) }) })
    })
  })
}

export function checkBoard(db: Db, req: BoardRequest): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const stored = getBoard(db, a.boardId)
    if (!stored) return notFound()
    const result = runCheck(stored.board)
    return ok({ ...result, statsLine: statsLine(result.stats), advisory: ADVISORY })
  })
}

/**
 * `GET /api/boards/:key/bench?flip=lr|tb`: the bench sheet, its bottom overviews turned over
 * left-right (the default) or top-bottom; any other `flip` is 422.
 */
export function benchBoard(db: Db, req: BoardRequest, date?: string, flipParam: unknown = 'lr'): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const stored = getBoard(db, a.boardId)
    if (!stored) return notFound()
    const flip = parseFlip(flipParam)
    if (!flip) return invalid('flip: must be lr or tb')
    // Keyed by the key asked with: a link's ticks never tie it to the board id or to another link.
    const hash = tickKey(createHash('sha256').update(`${req.key}:${stored.head}`).digest('hex'))
    const r = benchResponse(stored.board, hash, date, flip)
    return ok(r.body, r.headers)
  })
}

export function downloadBoard(db: Db, req: BoardRequest): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const stored = getBoard(db, a.boardId)
    if (!stored) return notFound()
    const filename = `${fileStem(stored.name)}.wirebender.json`
    return ok(`${JSON.stringify(stored.board, null, 2)}\n`, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${filename}"`
    })
  })
}

/**
 * `GET /api/boards/:key/thumbnail`: the top side, without labels, for the board lists. Kept
 * a minute by the browser only. The SVG may not run or load anything if opened on its own.
 */
export function thumbnailBoard(db: Db, req: BoardRequest): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const stored = getBoard(db, a.boardId)
    if (!stored) return notFound()
    // The export leaves out the namespace (it is inlined in HTML, and the bench sheet reads its
    // `<svg width=` prefix); an <img> renders nothing without it.
    const svg = boardOverviewSvg(stored.board, 'top', { title: false, labelSize: 0 }).replace(/^<svg /, '<svg xmlns="http://www.w3.org/2000/svg" ')
    return ok(svg, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox'
    })
  })
}

function change(db: Db, req: BoardRequest, step: (room: Room, author: string, authorId: string | null) => number | null, reason: string): ApiResult {
  return withAccess(db, req, 'edit', a => withRoom(db, a.boardId, (room) => {
    const revision = step(room, authorOf(req.who), authorIdOf(req.who))
    return revision === null ? { status: 409, body: { reason } } : ok({ revision })
  }))
}

export const undoBoard = (db: Db, req: BoardRequest): ApiResult => change(db, req, (r, author, authorId) => r.undo(author, authorId), 'nothing to undo')
export const redoBoard = (db: Db, req: BoardRequest): ApiResult => change(db, req, (r, author, authorId) => r.redo(author, authorId), 'nothing to redo')

export function listRevisionsResponse(db: Db, req: BoardRequest): ApiResult {
  return withAccess(db, req, 'view', a => ok(listRevisions(db, a.boardId)))
}

/** A revision number from a URL segment, or `null` if it is not a positive integer. */
function revisionNumber(segment: string): number | null {
  return /^[1-9]\d{0,9}$/.test(segment) ? Number(segment) : null
}

export function getRevisionResponse(db: Db, req: BoardRequest, segment: string): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const n = revisionNumber(segment)
    return foundOr404(n === null ? null : getRevision(db, a.boardId, n)?.board ?? null)
  })
}

export function restoreRevision(db: Db, req: BoardRequest, segment: string): ApiResult {
  return withAccess(db, req, 'edit', (a) => {
    const n = revisionNumber(segment)
    const rev = n === null ? null : getRevision(db, a.boardId, n)
    if (n === null || !rev) return notFound()
    return withRoom(db, a.boardId, room => ok({ revision: room.serverWrite(rev.board as BoardFile, { author: authorOf(req.who), how: 'restore', target: n, authorId: authorIdOf(req.who) }) }))
  })
}
