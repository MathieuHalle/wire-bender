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

const today = (now: number) => new Date(now).toISOString().slice(0, 10)

/** The bundle of board `id` and its name: its current board and every revision, oldest first. */
function bundleOf(db: Db, id: string): { name: string, zip: Uint8Array } | null {
  const stored = getBoard(db, id)
  if (!stored) return null
  const rows = db.select().from(revisions).where(eq(revisions.boardId, id)).orderBy(asc(revisions.n)).all()
  const list: BundleRevision[] = rows.map(r => ({
    n: r.n, createdAt: r.createdAt, author: r.author, how: r.how, target: r.target, summary: r.summary, board: JSON.parse(r.board) as BoardFile
  }))
  return { name: stored.name, zip: encodeBundle({ name: stored.name, exportedAt: Date.now(), board: stored.board, revisions: list }) }
}

/**
 * `GET /api/boards/:key/bundle`: the board with its whole history as `<name>.wirebender.zip`. Needs view.
 * Throttled like download-all (one at a time, EXPORTS_PER_MINUTE a minute, the same count), per user, or per
 * client `address` for a signed-out visitor on a view link. Only a granted request counts.
 */
export function exportBundle(db: Db, req: BoardRequest, address?: string, now = Date.now()): ApiResult {
  return withAccess(db, req, 'view', (a) => {
    const key = req.who.kind === 'anonymous' ? `peer:${address ?? 'unknown'}` : req.who.userId
    const refused = beginExport(key, now)
    if (refused) return refused
    try {
      const b = bundleOf(db, a.boardId)
      if (!b) return { status: 404, body: { error: 'not found' } }
      return { status: 200, body: b.zip, headers: downloadHeaders(`${fileStem(b.name)}.wirebender.zip`) }
    } finally {
      endExport(key)
    }
  })
}

const isHow = (how: string): how is RevisionHow => (REVISION_HOW as readonly string[]).includes(how)
const FIRST_HOW: readonly RevisionHow[] = ['create', 'import', 'fork']

/** An imported revision's `how`: unknown ones are `import`, and so is a #1 that is not a start (undo has nothing before #1). */
const howOf = (how: string, n: number): RevisionHow => !isHow(how) || (n === 1 && !FIRST_HOW.includes(how)) ? 'import' : how

/**
 * `POST /api/boards/import-bundle`: a new board of `who`'s from a bundle. The revisions are renumbered 1..N in
 * bundle order, undo, redo and restore targets follow (none left if the target is not in the bundle or is not older
 * than its own revision), and #1 is `import` unless it is a `create`, `import` or `fork`. Their authors are kept as
 * names only and flagged `imported`; one more `import` revision by `who` makes the bundle's board current.
 * All or nothing. `who` is signed in: the route answers 401 to anonymous callers before reading the body.
 */
export function importBundle(db: Db, bytes: Uint8Array, who: Exclude<Who, { kind: 'anonymous' }>): ApiResult {
  const decoded = decodeBundle(bytes, { maxBoardBytes: MAX_BOARD_BYTES })
  if (!decoded.ok) return { status: decoded.status, body: { error: decoded.error } }
  const { bundle } = decoded
  const id = randomUUID()
  const now = Date.now()
  const count = bundle.revisions.length
  const head = count + 1
  const renumbered = new Map(bundle.revisions.map((r, i) => [r.n, i + 1]))
  const ownerId = who.userId
  const author = who.author
  const tokenId = who.token?.id ?? null
  const stored = (board: BoardFile, n: number) => JSON.stringify({ ...board, revision: n })
  db.transaction((tx) => {
    tx.insert(boards).values({ id, name: bundle.board.name, createdAt: now, updatedAt: now, current: stored(bundle.board, head), head, ownerId, linkId: randomUUID() }).run()
    bundle.revisions.forEach((r, i) => {
      const n = i + 1
      const target = r.target === null ? null : renumbered.get(r.target) ?? null
      tx.insert(revisions).values({
        boardId: id, n, createdAt: r.createdAt, author: r.author, how: howOf(r.how, n),
        // A target is always an older revision; any other (a hand-made bundle) would send undo looking for #0.
        target: target !== null && target < n ? target : null,
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

/**
 * An entry name from a board or account name: path separators, control characters and the characters Windows
 * refuses become `_`, and an empty name or one of only dots (`.`, `..`) becomes `untitled`.
 */
// eslint-disable-next-line no-control-regex
const entryStem = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/^\.*$/, 'untitled')

/**
 * `name`, or `name (2)`, `name (3)` ... for the next one whose lower-cased form is already in `used` (a zip
 * extracted on macOS or Windows would merge names that differ only by case).
 */
function unique(used: Set<string>, name: string, suffix = ''): string {
  let candidate = `${name}${suffix}`
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${name} (${i})${suffix}`
  used.add(candidate.toLowerCase())
  return candidate
}

const BUNDLE_SUFFIX = '.wirebender.zip'

/** A zip of one bundle per board of `ownerId`, trashed boards left out. */
export function exportAll(db: Db, ownerId: string): Uint8Array {
  const used = new Set<string>()
  const entries: Record<string, Uint8Array> = {}
  for (const b of listBoards(db, ownerId, 'mine')) {
    const made = bundleOf(db, b.id)
    if (made) entries[unique(used, entryStem(b.name), BUNDLE_SUFFIX)] = made.zip
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
    const made = bundleOf(db, b.id)
    if (made) entries[`${dir}/${unique(names, entryStem(b.name), BUNDLE_SUFFIX)}`] = made.zip
  }
  return zipSync(entries, { level: 0 })
}

// Exports are synchronous work on the event loop, so each user may run one at a time and a few a minute.

export const EXPORTS_PER_MINUTE = 6
export const TOO_MANY_EXPORTS = 'Too many exports. Wait a minute and try again.'
const EXPORT_WINDOW_MS = 60_000
const exporting = new Set<string>()
const exportsBy = new Map<string, number[]>()

/** Tests only: forget the export counters. */
export function resetExportRate(): void {
  exporting.clear()
  exportsBy.clear()
}

/** Start an export for `userId`: the 429 to answer with if one is running or the minute's cap is used, else null (call `endExport` after). */
export function beginExport(userId: string, now = Date.now()): ApiResult | null {
  const recent = (exportsBy.get(userId) ?? []).filter(t => now - t < EXPORT_WINDOW_MS)
  if (exporting.has(userId) || recent.length >= EXPORTS_PER_MINUTE) {
    exportsBy.set(userId, recent)
    return { status: 429, body: { error: TOO_MANY_EXPORTS } }
  }
  exportsBy.set(userId, [...recent, now])
  exporting.add(userId)
  return null
}

export function endExport(userId: string): void {
  exporting.delete(userId)
}

function throttled(userId: string, now: number, make: () => Uint8Array, filename: string): ApiResult {
  const refused = beginExport(userId, now)
  if (refused) return refused
  try {
    return { status: 200, body: make(), headers: downloadHeaders(filename) }
  } finally {
    endExport(userId)
  }
}

/** `GET /api/me/export`: `wirebender-boards-<date>.zip` with all of the caller's boards (the date is UTC). */
export function exportAllResult(db: Db, who: Who, now = Date.now()): ApiResult {
  if (who.kind === 'anonymous') return { status: 401, body: { error: 'Sign in first.' } }
  return throttled(who.userId, now, () => exportAll(db, who.userId), `wirebender-boards-${today(now)}.zip`)
}

/** `GET /api/admin/export`: the whole server for an admin; 404 for anyone else, like the other admin routes (tokens are refused earlier). */
export function exportServerResult(db: Db, who: Who, now = Date.now()): ApiResult {
  if (who.kind !== 'user' || !who.isAdmin) return { status: 404, body: { error: 'not found' } }
  return throttled(who.userId, now, () => exportServer(db), `wirebender-server-${today(now)}.zip`)
}
