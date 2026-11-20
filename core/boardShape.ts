// Which holes a board has, and its outline. A board is its `cols × rows` grid, cut to its
// `shape`: round, with chamfered or notched corners (as seen from the top), or only its strip
// holes (`strips`, a rectangle outline). The tools, the check and every drawing ask here, so a
// hole that is drawn is a hole that can be used.
import { holeKey, holeMm, type Hole } from './holes'
import { stripIndex } from './strips'
import { underOpening } from './features'
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
  return inShape(b, h) && !underOpening(b, h)
}

/** In the board's shape (round, corners, strips), cutouts and mounting holes aside. */
function inShape(b: Board, h: Hole): boolean {
  const s = b.shape
  if (!s) return true
  if (s.kind === 'strips') return stripIndex(b).has(holeKey(h))
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

/** How far the board reaches past a mounting hole's edge, mm, when the hole sits beyond the margin. */
const MOUNT_EDGE_MM = 1.5

/**
 * The board's rectangle in board mm: `marginPitch` past the outer hole centres, grown where a
 * mounting hole (of a board without a `shape`) sits beyond it, so the hole has board around it.
 */
export function boardRectMm(b: Board, marginPitch = 0.5): { x0: number, y0: number, x1: number, y1: number } {
  const p = b.pitchMm
  const r = { x0: -marginPitch * p, y0: -marginPitch * p, x1: (b.cols - 1 + marginPitch) * p, y1: (b.rows - 1 + marginPitch) * p }
  if (b.shape) return r
  for (const m of b.mountingHoles ?? []) {
    const e = m.diameterMm / 2 + MOUNT_EDGE_MM
    r.x0 = Math.min(r.x0, m.x - e)
    r.y0 = Math.min(r.y0, m.y - e)
    r.x1 = Math.max(r.x1, m.x + e)
    r.y1 = Math.max(r.y1, m.y + e)
  }
  return r
}

/** True when a mounting hole makes a plain board larger than its margin (`boardRectMm`). */
export function rectGrown(b: Board, marginPitch = 0.5): boolean {
  if (b.shape || !b.mountingHoles?.length) return false
  const p = b.pitchMm
  const r = boardRectMm(b, marginPitch)
  return r.x0 < -marginPitch * p || r.y0 < -marginPitch * p || r.x1 > (b.cols - 1 + marginPitch) * p || r.y1 > (b.rows - 1 + marginPitch) * p
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
  if (!b.shape) {
    const r = boardRectMm(b, m)
    return { kind: 'polygon', points: [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }] }
  }
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
  // Two cuts on one edge can meet at the same point (a zero-length edge): keep it once.
  const same = (a: { x: number, y: number }, c: { x: number, y: number }) => Math.abs(a.x - c.x) < 1e-9 && Math.abs(a.y - c.y) < 1e-9
  return { kind: 'polygon', points: points.filter((q, i) => !same(q, points[(i + points.length - 1) % points.length]!)) }
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
  if (!b.shape && !rectGrown(b, marginPitch)) return null
  const o = boardOutline(b, marginPitch)
  if (o.kind === 'circle') return { kind: 'circle', cx: map.x(o.cx), cy: map.y(o.cy), r: o.r }
  return { kind: 'polygon', points: o.points.map(p => ({ x: map.x(p.x), y: map.y(p.y) })) }
}

/** Which side of line a→b the point c is on: > 0, < 0, or 0 on the line (within `EPS` mm²). */
const EPS = 1e-9
function turn(a: { x: number, y: number }, b: { x: number, y: number }, c: { x: number, y: number }): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  return Math.abs(v) < EPS ? 0 : Math.sign(v)
}
const within = (a: number, b: number, v: number) => Math.min(a, b) - EPS <= v && v <= Math.max(a, b) + EPS
type P = { x: number, y: number }
const onSegment = (a: P, b: P, c: P) => within(a.x, b.x, c.x) && within(a.y, b.y, c.y)
/** True when segments ab and cd cross or touch (an end on the other, or overlapping). */
function meet(a: P, b: P, c: P, d: P): boolean {
  const t1 = turn(a, b, c)
  const t2 = turn(a, b, d)
  const t3 = turn(c, d, a)
  const t4 = turn(c, d, b)
  if (t1 !== t2 && t3 !== t4 && t1 * t2 <= 0 && t3 * t4 <= 0 && (t1 !== 0 || t2 !== 0)) return true
  return (t1 === 0 && onSegment(a, b, c)) || (t2 === 0 && onSegment(a, b, d))
    || (t3 === 0 && onSegment(c, d, a)) || (t4 === 0 && onSegment(c, d, b))
}

/**
 * True when the outline (2D margin) is one simple polygon: no two edges that are not neighbours
 * cross or touch. Cuts on opposite corners that overlap or meet break this, splitting the board.
 */
export function outlineIsSimple(b: Board): boolean {
  const pts = outlinePoints(b, 0.5)
  const n = pts.length
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // neighbours through the closing edge
      if (meet(pts[i]!, pts[(i + 1) % n]!, pts[j]!, pts[(j + 1) % n]!)) return false
    }
  return true
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
