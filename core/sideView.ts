// One side of the board as drawn: board mm, x optionally mirrored (the bottom seen from
// below). The export and the editor both draw through this, so they cannot drift apart.
import { holeMm, parseHole, type Hole } from './holes'
import type { BoardFile, Side } from './schema'

export interface SidePt { x: number, y: number }

export interface SideMap {
  pitch: number
  /** x of the last column centre. */
  span: number
  mirrored: boolean
  x(v: number): number
  pt(h: Hole): SidePt
}

/** Board mm -> drawing mm for one side; mirrored flips x about the board's centre. */
export function sideMap(board: BoardFile, mirrored: boolean): SideMap {
  const pitch = board.board.pitchMm
  const span = (board.board.cols - 1) * pitch
  const x = (v: number) => (mirrored ? span - v : v)
  return {
    pitch,
    span,
    mirrored,
    x,
    pt(h) {
      const m = holeMm(h, pitch)
      return { x: x(m.x), y: m.y }
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
export function ghostWires(board: BoardFile, side: Side, mirrored: boolean): GhostWire[] {
  const m = sideMap(board, mirrored)
  return board.wires.filter(w => w.side !== side && w.points.length > 0).map((w) => {
    const pts = w.points.map(h => m.pt(parseHole(h)))
    return { id: w.id, kind: w.kind, points: w.kind === 'flying' ? [pts[0]!, pts[pts.length - 1]!] : pts }
  })
}
