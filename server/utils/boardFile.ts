import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { parseBoard, type BoardFile } from '~core/schema'

export const DEFAULT_BOARD = 'data/channel-board-2.wirebender.json'

export type ReadResult = { ok: true, board: BoardFile } | { ok: false, errors: string[] }
export type WriteResult =
  | { ok: true, revision: number }
  | { ok: false, conflict: true, current: number | null }

/** Absolute board path from WIREBENDER_BOARD (relative to cwd) or the demo default. */
export function boardPath(): string {
  return path.resolve(process.cwd(), process.env.WIREBENDER_BOARD || DEFAULT_BOARD)
}

export async function readBoard(file: string): Promise<ReadResult> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    return { ok: false, errors: [`cannot read file: ${(e as Error).message}`] }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] }
  }
  return parseBoard(json)
}

export async function writeBoard(file: string, board: BoardFile, baseRevision: number): Promise<WriteResult> {
  const disk = await readBoard(file)
  if (!disk.ok) return { ok: false, conflict: true, current: null }
  if (disk.board.revision !== baseRevision) {
    return { ok: false, conflict: true, current: disk.board.revision }
  }
  const revision = baseRevision + 1
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify({ ...board, revision }, null, 2) + '\n')
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
  return { ok: true, revision }
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
