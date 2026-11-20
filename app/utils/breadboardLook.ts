// What makes a board look like a breadboard or a stripboard in 2D, in a side's own coordinates
// (`Geo`, mirrored with it): the channel between the clip halves, the red and blue rail lines, and
// a stripboard's copper bands. Pure geometry; Holes.vue draws it.
import { parseHole } from '~core/holes'
import { stripSegments } from '~core/strips'
import type { BoardFile } from '~core/schema'
import type { Geo } from './boardView'

export const RAIL_COLORS: Record<'+' | '-', string> = { '+': '#d62839', '-': '#1f5fbf' }

export interface RailLine { x1: number, x2: number, y: number, sign: '+' | '-', color: string }
export interface Rect { x: number, y: number, w: number, h: number }

/** The x span of the grid, half a pitch past the outer columns, as this side draws it. */
function spanX(geo: Geo): { x0: number, x1: number } {
  const a = geo.pt({ col: 1, row: 1 }).x
  const b = geo.pt({ col: geo.cols, row: 1 }).x
  return { x0: Math.min(a, b) - geo.pitch / 2, x1: Math.max(a, b) + geo.pitch / 2 }
}

/**
 * The channel: the rows between the rows printed `e` and `f`, drawn as a groove a little narrower
 * than the gap. Null without those labels.
 */
export function channelRect(board: BoardFile, geo: Geo): Rect | null {
  const labels = board.board.rowLabels ?? []
  const re = labels.indexOf('e') + 1
  const rf = labels.indexOf('f') + 1
  if (!re || !rf || Math.abs(re - rf) < 2) return null
  const ya = geo.pt({ col: 1, row: Math.min(re, rf) }).y
  const yb = geo.pt({ col: 1, row: Math.max(re, rf) }).y
  const top = Math.min(ya, yb) + geo.pitch * 0.75
  const bottom = Math.max(ya, yb) - geo.pitch * 0.75
  const { x0, x1 } = spanX(geo)
  return { x: x0, y: top, w: x1 - x0, h: Math.max(bottom - top, geo.pitch * 0.4) }
}

/**
 * A line beside each rail strip (a row printed `+` or `-`), on the side away from the other rail of
 * its pair, as on the print: red for `+`, blue for `-`. A split rail gets one line per strip.
 */
export function railLines(board: BoardFile, geo: Geo): RailLine[] {
  const labels = board.board.rowLabels ?? []
  const sign = (row: number) => labels[row - 1] === '+' || labels[row - 1] === '-' ? labels[row - 1] as '+' | '-' : null
  const out: RailLine[] = []
  for (const s of board.board.strips ?? []) {
    const a = parseHole(s.from)
    const b = parseHole(s.to)
    const sg = sign(a.row)
    if (a.row !== b.row || !sg) continue
    // Away from the partner rail (the neighbouring rail row), else away from the board's middle.
    const partner = sign(a.row - 1) ? -1 : sign(a.row + 1) ? 1 : a.row <= geo.rows / 2 ? 1 : -1
    const out1 = geo.pt({ col: a.col, row: a.row - partner * 0.6 })
    const pa = geo.pt(a)
    const pb = geo.pt(b)
    out.push({ x1: Math.min(pa.x, pb.x) - geo.pitch / 2, x2: Math.max(pa.x, pb.x) + geo.pitch / 2, y: out1.y, sign: sg, color: RAIL_COLORS[sg] })
  }
  return out
}

/**
 * A stripboard's copper bands under its drilled holes (the bottom side): one per piece of strip
 * between cuts, so a cut shows as a gap in the copper.
 */
export function stripBands(board: BoardFile, geo: Geo): Rect[] {
  const w = geo.pitch * 0.84
  return stripSegments(board.board, board.cuts).map((s) => {
    const pts = [geo.pt(s.holes[0]!), geo.pt(s.holes[s.holes.length - 1]!)]
    const x0 = Math.min(pts[0]!.x, pts[1]!.x)
    const x1 = Math.max(pts[0]!.x, pts[1]!.x)
    const y0 = Math.min(pts[0]!.y, pts[1]!.y)
    const y1 = Math.max(pts[0]!.y, pts[1]!.y)
    return { x: x0 - w / 2, y: y0 - w / 2, w: x1 - x0 + w, h: y1 - y0 + w }
  })
}
