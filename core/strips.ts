// Copper strips the board comes with (`board.strips`): a stripboard's rows of copper, a
// breadboard's clips and rails. Each strip is a straight run `from` to `to` along one row or one
// column, joining every hole on it. Connectivity, `holeExists` (the `strips` shape) and the
// drawings all read strips through here.
import { holeKey, parseHole, type Hole } from './holes'
import type { BoardFile } from './schema'

type Board = BoardFile['board']
export interface Strip { from: string, to: string }

/** The strip's holes, from `from` to `to` inclusive. Empty when it isn't along a row or column. */
export function stripHoles(s: Strip): Hole[] {
  const a = parseHole(s.from)
  const b = parseHole(s.to)
  if (a.col !== b.col && a.row !== b.row) return []
  const n = Math.max(Math.abs(b.col - a.col), Math.abs(b.row - a.row))
  const dc = Math.sign(b.col - a.col)
  const dr = Math.sign(b.row - a.row)
  return Array.from({ length: n + 1 }, (_, i) => ({ col: a.col + i * dc, row: a.row + i * dr }))
}

// Boards are replaced, not changed, on every edit: the strips array is a stable key.
const indexCache = new WeakMap<Strip[], Map<string, number>>()

/**
 * Hole key → the index of the strip on it (the first, if strips overlap: the format refuses
 * that). Bad hole names are skipped (the format reports them). Cached per `strips` array.
 */
export function stripIndex(b: Board): Map<string, number> {
  const strips = b.strips ?? []
  let m = indexCache.get(strips)
  if (m) return m
  m = new Map()
  strips.forEach((s, i) => {
    let hs: Hole[]
    try {
      hs = stripHoles(s)
    } catch {
      return
    }
    for (const h of hs) if (!m!.has(holeKey(h))) m!.set(holeKey(h), i)
  })
  indexCache.set(strips, m)
  return m
}

export const isBreadboard = (b: Board): boolean => b.type === 'breadboard'
