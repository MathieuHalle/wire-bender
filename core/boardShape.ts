// Which holes a board has, and its outline. A board is its `cols × rows` grid, cut to its
// `shape` (round, or with chamfered or notched corners, as seen from the top). The tools, the
// check and every drawing ask here, so a hole that is drawn is a hole that can be used.
import { holeMm, type Hole } from './holes'
import type { BoardFile, Corner } from './schema'

type Board = BoardFile['board']

/** A hole exists when its centre is at least this far inside the outline (in pitches). */
const RIM = 0.25
const CORNERS: Corner[] = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']
const isLeft = (c: Corner) => c === 'topLeft' || c === 'bottomLeft'
const isTop = (c: Corner) => c === 'topLeft' || c === 'topRight'

/** The hole's place counted from corner `c`: 0, 0 is the corner hole. */
const fromCorner = (b: Board, h: Hole, c: Corner) => ({
  dc: isLeft(c) ? h.col - 1 : b.cols - h.col,
  dr: isTop(c) ? h.row - 1 : b.rows - h.row
})

/** True when the board has this hole: in the grid, and inside its shape. */
export function holeExists(b: Board, h: Hole): boolean {
  if (h.col < 1 || h.row < 1 || h.col > b.cols || h.row > b.rows) return false
  const s = b.shape
  if (!s) return true
  if (s.kind === 'round') {
    const r = Math.min(b.cols, b.rows) / 2
    return Math.hypot(h.col - (b.cols + 1) / 2, h.row - (b.rows + 1) / 2) <= r - RIM + 1e-9
  }
  for (const c of CORNERS) {
    const cut = s.corners[c]
    if (!cut) continue
    const { dc, dr } = fromCorner(b, h, c)
    if (cut.cut === 'notch' ? dc < cut.holes && dr < cut.holes : dc + dr < cut.holes) return false
  }
  return true
}

/** Every hole the board has, row by row from A1. */
export function existingHoles(b: Board): Hole[] {
  const out: Hole[] = []
  for (let row = 1; row <= b.rows; row++)
    for (let col = 1; col <= b.cols; col++) if (holeExists(b, { col, row })) out.push({ col, row })
  return out
}

/** Board mm, A1 at (0, 0): x right, y down. */
export type Outline = { kind: 'circle', cx: number, cy: number, r: number } | { kind: 'polygon', points: { x: number, y: number }[] }

/**
 * The board's edge, `marginPitch` pitches past the outer hole centres (the 2D view uses 0.5; the
 * 3D slab 1.5, for its printed numbers). A plain rectangle is a 4-point polygon.
 */
export function boardOutline(b: Board, marginPitch = 0.5): Outline {
  const p = b.pitchMm
  const m = marginPitch
  if (b.shape?.kind === 'round')
    return { kind: 'circle', cx: ((b.cols - 1) * p) / 2, cy: ((b.rows - 1) * p) / 2, r: (Math.min(b.cols, b.rows) / 2 - 0.5 + m) * p }
  const corners = b.shape?.kind === 'corners' ? b.shape.corners : {}
  const points: { x: number, y: number }[] = []
  for (const c of CORNERS) {
    // In corner terms (dc along the horizontal edge, dr along the vertical one), from the
    // vertical edge to the horizontal one.
    const cut = corners[c]
    let local: [number, number][]
    if (!cut) local = [[-m, -m]]
    else if (cut.cut === 'notch') local = [[-m, cut.holes - 0.5], [cut.holes - 0.5, cut.holes - 0.5], [cut.holes - 0.5, -m]]
    else {
      // The 45° line dc + dr = L, moved out from its half-pitch place with the margin.
      const L = cut.holes - 0.5 - (m - 0.5) * Math.SQRT2
      local = [[-m, L + m], [L + m, -m]]
    }
    // Clockwise (y down): the left corners come from their vertical edge, the right ones from
    // their horizontal edge.
    const ordered = (c === 'topLeft' || c === 'bottomRight') ? local : [...local].reverse()
    for (const [dc, dr] of ordered) {
      const col = isLeft(c) ? 1 + dc : b.cols - dc
      const row = isTop(c) ? 1 + dr : b.rows - dr
      points.push(holeMm({ col, row }, p))
    }
  }
  return { kind: 'polygon', points }
}

/**
 * A shaped board's outline as a side draws it: board mm mapped through the side's `x` / `y`
 * (its mirroring). Null for a plain board, which each drawing keeps as its own rectangle.
 */
export function shapeOutline(
  b: Board,
  map: { x(v: number): number, y(v: number): number },
  marginPitch = 0.5
): { kind: 'circle', cx: number, cy: number, r: number } | { kind: 'polygon', points: { x: number, y: number }[] } | null {
  if (!b.shape) return null
  const o = boardOutline(b, marginPitch)
  if (o.kind === 'circle') return { kind: 'circle', cx: map.x(o.cx), cy: map.y(o.cy), r: o.r }
  return { kind: 'polygon', points: o.points.map(p => ({ x: map.x(p.x), y: map.y(p.y) })) }
}

/** The outline as a polygon (a circle in `segments` points), board mm. */
export function outlinePoints(b: Board, marginPitch = 0.5, segments = 64): { x: number, y: number }[] {
  const o = boardOutline(b, marginPitch)
  if (o.kind === 'polygon') return o.points
  return Array.from({ length: segments }, (_, i) => {
    const a = (2 * Math.PI * i) / segments
    return { x: o.cx + o.r * Math.cos(a), y: o.cy + o.r * Math.sin(a) }
  })
}
