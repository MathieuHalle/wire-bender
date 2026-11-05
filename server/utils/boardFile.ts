import { promises as fs } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { parseBoard, type BoardFile } from '~core/schema'

export const DEFAULT_BOARD = 'data/channel-board-2.wirebender.json'

/** `hash` is the sha256 hex of the file bytes: what a PUT must name as its base. */
export type ReadResult = { ok: true, board: BoardFile, hash: string } | { ok: false, errors: string[] }
export type WriteResult =
  | { ok: true, revision: number, hash: string }
  | { ok: false, conflict: true, current: number | null, hash?: string }

export function hashBytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Absolute board path from WIREBENDER_BOARD (relative to cwd) or the demo default. */
export function boardPath(): string {
  return path.resolve(process.cwd(), process.env.WIREBENDER_BOARD || DEFAULT_BOARD)
}

export async function readBoard(file: string): Promise<ReadResult> {
  let bytes: Buffer
  try {
    bytes = await fs.readFile(file)
  } catch (e) {
    return { ok: false, errors: [`cannot read file: ${(e as Error).message}`] }
  }
  const text = bytes.toString('utf8')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] }
  }
  const r = parseBoard(json)
  return r.ok ? { ...r, hash: hashBytes(bytes) } : r
}

const queues = new Map<string, Promise<unknown>>()

/**
 * Writes only when the file on disk is still the one the client based its edit on:
 * same bytes (`baseHash`) and same `baseRevision`. The hash catches hand edits that
 * keep the revision. The new revision is baseRevision + 1.
 *
 * Serialises the whole read-check-write-rename per file within this process.
 * Known limit: an external writer (Claude editing on disk) can still slip in
 * between the check and the rename; closing that needs OS file locking.
 */
export function writeBoard(file: string, board: BoardFile, baseRevision: number, baseHash: string): Promise<WriteResult> {
  const prev = queues.get(file) ?? Promise.resolve()
  const run = prev.then(() => writeBoardUnlocked(file, board, baseRevision, baseHash))
  const tail = run.catch(() => {})
  queues.set(file, tail)
  void tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file)
  })
  return run
}

async function writeBoardUnlocked(file: string, board: BoardFile, baseRevision: number, baseHash: string): Promise<WriteResult> {
  const disk = await readBoard(file)
  if (!disk.ok) return { ok: false, conflict: true, current: null }
  if (disk.hash !== baseHash || disk.board.revision !== baseRevision) {
    return { ok: false, conflict: true, current: disk.board.revision, hash: disk.hash }
  }
  const revision = baseRevision + 1
  const text = JSON.stringify({ ...board, revision }, null, 2) + '\n'
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, text)
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
  return { ok: true, revision, hash: hashBytes(text) }
}

interface Shared { watcher: FSWatcher, listeners: Set<(revision: number | null) => void> }
const shared = new Map<string, Shared>()

/** One chokidar watcher per path, fanned out to all listeners; closed with the last one. */
export function watchBoard(file: string, onChange: (revision: number | null) => void): () => void {
  let entry = shared.get(file)
  if (!entry) {
    const listeners = new Set<(revision: number | null) => void>()
    const watcher = chokidar.watch(file, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 }
    })
    const fire = async () => {
      const r = await readBoard(file)
      const rev = r.ok ? r.board.revision : null
      for (const l of [...listeners]) l(rev)
    }
    watcher.on('add', fire).on('change', fire)
    entry = { watcher, listeners }
    shared.set(file, entry)
  }
  const e = entry
  e.listeners.add(onChange)
  return () => {
    if (!e.listeners.delete(onChange) || e.listeners.size > 0) return
    shared.delete(file)
    void e.watcher.close()
  }
}
