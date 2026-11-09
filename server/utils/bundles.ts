// Board bundles on the server (step 4): one board with its whole history as a zip, download-all
// (a zip of bundles) and the admin's export of every account.
import { randomUUID } from 'node:crypto'
import { zipSync } from 'fflate'
import { asc, eq } from 'drizzle-orm'
import { decodeBundle, encodeBundle, type BundleRevision } from '~core/bundle'
import type { BoardFile } from '~core/schema'
import type { Db } from '../db'
import { boards, revisions, users, REVISION_HOW, type RevisionHow } from '../db/schema'
import { withAccess, type ApiResult, type BoardRequest } from './api'
import { fileStem } from './bench'
import { MAX_BOARD_BYTES, getBoard, listBoards } from './boards'
import { authorIdOf, type Who } from './who'

const downloadHeaders = (filename: string): Record<string, string> => ({
  'content-type': 'application/zip',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-disposition': `attachment; filename="${filename}"`
})

const today = () => new Date().toISOString().slice(0, 10)

/** The bundle of board `id`: its current board and every revision, oldest first. */
function bundleOf(db: Db, id: string): Uint8Array | null {
  const stored = getBoard(db, id)
  if (!stored) return null
  const rows = db.select().from(revisions).where(eq(revisions.boardId, id)).orderBy(asc(revisions.n)).all()
  const list: BundleRevision[] = rows.map(r => ({
    n: r.n, createdAt: r.createdAt, author: r.author, how: r.how, target: r.target, summary: r.summary, board: JSON.parse(r.board) as BoardFile
  }))
  return encodeBundle({ name: stored.name, exportedAt: Date.now(), board: stored.board, revisions: list })
}

/** `GET /api/boards/:key/bundle`: the board with its whole history as `<name>.wirebender.zip`. Needs view. */
export function exportBundle(db: Db, req: BoardRequest): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const zip = bundleOf(db, a.boardId)
    const stored = getBoard(db, a.boardId)
    if (!zip || !stored) return { status: 404, body: { error: 'not found' } }
    return { status: 200, body: zip, headers: downloadHeaders(`${fileStem(stored.name)}.wirebender.zip`) }
  })
}

const isHow = (how: string): how is RevisionHow => (REVISION_HOW as readonly string[]).includes(how)

/**
 * `POST /api/boards/import-bundle`: a new board of `who`'s from a bundle. The revisions are renumbered 1..N in
 * bundle order, undo and redo targets follow (none left if the target is not in the bundle), their authors are
 * kept as names only and flagged `imported`; one more `import` revision by `who` makes the bundle's board current.
 * All or nothing.
 */
export function importBundle(db: Db, bytes: Uint8Array, who: Who): ApiResult {
  const decoded = decodeBundle(bytes, { maxBoardBytes: MAX_BOARD_BYTES })
  if (!decoded.ok) return { status: decoded.status, body: { error: decoded.error } }
  const { bundle } = decoded
  const id = randomUUID()
  const now = Date.now()
  const count = bundle.revisions.length
  const head = count + 1
  const renumbered = new Map(bundle.revisions.map((r, i) => [r.n, i + 1]))
  const ownerId = who.kind === 'anonymous' ? 'local' : who.userId
  const author = who.kind === 'anonymous' ? 'Local' : who.author
  const tokenId = who.kind === 'anonymous' ? null : who.token?.id ?? null
  const stored = (board: BoardFile, n: number) => JSON.stringify({ ...board, revision: n })
  db.transaction((tx) => {
    tx.insert(boards).values({ id, name: bundle.board.name, createdAt: now, updatedAt: now, current: stored(bundle.board, head), head, ownerId, linkId: randomUUID() }).run()
    bundle.revisions.forEach((r, i) => {
      tx.insert(revisions).values({
        boardId: id, n: i + 1, createdAt: r.createdAt, author: r.author, how: isHow(r.how) ? r.how : 'import',
        target: r.target === null ? null : renumbered.get(r.target) ?? null,
        summary: r.summary, board: stored(r.board, i + 1), authorId: null, tokenId: null, imported: 1
      }).run()
    })
    tx.insert(revisions).values({
      boardId: id, n: head, createdAt: now, author, how: 'import', target: null,
      summary: `imported bundle (${count} revisions)`,
      board: stored(bundle.board, head), authorId: authorIdOf(who), tokenId, imported: 0
    }).run()
  })
  return { status: 201, body: { id, name: bundle.board.name, head, revisions: count } }
}

/** An entry name from a board or account name: no path separators or control characters. */
// eslint-disable-next-line no-control-regex
const entryStem = (name: string) => name.replace(/[/\\\u0000-\u001f\u007f]/g, '-').trim() || 'board'

/** `name`, or `name (2)`, `name (3)` ... for the next one with a name already in `used`. */
function unique(used: Set<string>, name: string, suffix = ''): string {
  let candidate = `${name}${suffix}`
  for (let i = 2; used.has(candidate); i++) candidate = `${name} (${i})${suffix}`
  used.add(candidate)
  return candidate
}

const BUNDLE_SUFFIX = '.wirebender.zip'

/** A zip of one bundle per board of `ownerId`, trashed boards left out. */
export function exportAll(db: Db, ownerId: string): Uint8Array {
  const used = new Set<string>()
  const entries: Record<string, Uint8Array> = {}
  for (const b of listBoards(db, ownerId, 'mine')) {
    const zip = bundleOf(db, b.id)
    if (zip) entries[unique(used, entryStem(b.name), BUNDLE_SUFFIX)] = zip
  }
  return zipSync(entries, { level: 0 })
}

/** A zip of every board of every account (trashed ones too: it is a backup), as `<owner>/<board>.wirebender.zip`. */
export function exportServer(db: Db): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  const owners = new Set<string>()
  const dirs = new Map<string, string>()
  for (const u of db.select().from(users).orderBy(asc(users.createdAt), asc(users.id)).all()) {
    dirs.set(u.id, unique(owners, entryStem(u.name)))
  }
  const used = new Map<string, Set<string>>()
  for (const b of db.select({ id: boards.id, name: boards.name, ownerId: boards.ownerId }).from(boards).orderBy(asc(boards.createdAt), asc(boards.id)).all()) {
    const dir = dirs.get(b.ownerId) ?? unique(owners, entryStem(b.ownerId))
    dirs.set(b.ownerId, dir)
    const names = used.get(dir) ?? new Set<string>()
    used.set(dir, names)
    const zip = bundleOf(db, b.id)
    if (zip) entries[`${dir}/${unique(names, entryStem(b.name), BUNDLE_SUFFIX)}`] = zip
  }
  return zipSync(entries, { level: 0 })
}

/** `GET /api/me/export`: `wirebender-boards-<date>.zip` with all of the caller's boards. */
export function exportAllResult(db: Db, who: Who): ApiResult {
  if (who.kind === 'anonymous') return { status: 401, body: { error: 'Sign in first.' } }
  return { status: 200, body: exportAll(db, who.userId), headers: downloadHeaders(`wirebender-boards-${today()}.zip`) }
}

/** `GET /api/admin/export`: the whole server for an admin; 403 for anyone else (tokens are refused earlier). */
export function exportServerResult(db: Db, who: Who): ApiResult {
  if (who.kind !== 'user' || !who.isAdmin) return { status: 403, body: { error: 'Admins only.' } }
  return { status: 200, body: exportServer(db), headers: downloadHeaders(`wirebender-server-${today()}.zip`) }
}
