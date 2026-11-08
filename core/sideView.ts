// One side of the board as drawn: board mm, optionally mirrored (the bottom seen from
// below), left-right or top-bottom. The export and the editor both draw through this, so
// they cannot drift apart.
import { holeMm, parseHole, type Hole } from './holes'
import type { BoardFile, Side } from './schema'

export interface SidePt { x: number, y: number }

/**
 * How the bottom is turned over to be seen from below: `lr` sideways (x mirrored, the
 * default), `tb` end over end (y mirrored).
 */
export type Flip = 'lr' | 'tb'
/** How one side is drawn: as it is, or mirrored along a flip. */
export type Mirror = 'none' | Flip

export const FLIPS: readonly Flip[] = ['lr', 'tb']

/** `v` as a flip, or null if it is not exactly `lr` or `tb`. */
export function parseFlip(v: unknown): Flip | null {
  return v === 'lr' || v === 'tb' ? v : null
}

export interface SideMap {
  pitch: number
  /** x of the last column centre. */
  span: number
  /** y of the last row centre. */
  height: number
  mirror: Mirror
  /** Mirrored either way. */
  mirrored: boolean
  /** Board mm -> drawing mm along x, and along y; each is its own inverse. */
  x(v: number): number
  y(v: number): number
  pt(h: Hole): SidePt
  /** A board-mm rectangle as drawn. */
  rect(r: { x: number, y: number, w: number, h: number }): { x: number, y: number, w: number, h: number }
  /** Drawing mm -> fractional hole coordinates (col, row): the inverse of `pt`. */
  hole(p: SidePt): { col: number, row: number }
}

/** Board mm -> drawing mm for one side: `lr` flips x about the board's centre, `tb` flips y. */
export function sideMap(board: BoardFile, mirror: Mirror): SideMap {
  const pitch = board.board.pitchMm
  const span = (board.board.cols - 1) * pitch
  const height = (board.board.rows - 1) * pitch
  const x = (v: number) => (mirror === 'lr' ? span - v : v)
  const y = (v: number) => (mirror === 'tb' ? height - v : v)
  return {
    pitch,
    span,
    height,
    mirror,
    mirrored: mirror !== 'none',
    x,
    y,
    pt(h) {
      const m = holeMm(h, pitch)
      return { x: x(m.x), y: y(m.y) }
    },
    rect(r) {
      return {
        x: mirror === 'lr' ? span - r.x - r.w : r.x,
        y: mirror === 'tb' ? height - r.y - r.h : r.y,
        w: r.w,
        h: r.h
      }
    },
    hole(p) {
      return { col: x(p.x) / pitch + 1, row: y(p.y) / pitch + 1 }
    }
  }
}

/** A wire of the other side, as a polyline in this side's drawing mm. */
export interface GhostWire { id: string, kind: 'laid' | 'flying', points: SidePt[] }

/**
 * The wires laid on the side opposite `side`, mapped like `side` is drawn: laid wires
 * along their points, flying wires as one straight piece between their ends. Drawing
 * only; nothing here touches connectivity or the check.
 */
export function ghostWires(board: BoardFile, side: Side, mirror: Mirror): GhostWire[] {
  const m = sideMap(board, mirror)
  return board.wires.filter(w => w.side !== side && w.points.length > 0).map((w) => {
    const pts = w.points.map(h => m.pt(parseHole(h)))
    return { id: w.id, kind: w.kind, points: w.kind === 'flying' ? [pts[0]!, pts[pts.length - 1]!] : pts }
  })
}
