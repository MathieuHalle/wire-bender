// The Move tool's copy: what a side draws for the held part or wire, where it would land.
import type { BoardFile } from '~core/schema'
import type { Hole } from '~core/holes'
import { placePart, type PlacedPart } from '~core/footprints'
import { mapHole, type Placement } from '~core/move'
import type { Geo } from './boardView'

/** The Move copy's colour where it cannot go. */
export const REFUSED = '#e5484d'

/** What a side is given to draw the copy: the moved board (or the unmoved one and a `ghost`), the held item's key. */
export interface Moving {
  board: BoardFile
  /** `part:<ref>` or `wire:<id>`. */
  key: string
  /** True when the copy may be set down there. */
  ok: boolean
  /** Set when `board` is unmoved: draw the item through this placement (see `MoveResult.ghost`). */
  ghost?: Placement
  /** The bottom side's copy of a held part: only its leg folds (Task 4 of the follow-ups plan). */
  folds?: boolean
}

export interface MoveCopy {
  /** A board with just the held part or wire. */
  board: BoardFile
  placed: PlacedPart[]
  tint: string | null
  ghost: Placement | null
  folds: boolean
}

/** The held item alone, as it would land. */
export function moveCopy(moving: Moving | null): MoveCopy | null {
  if (!moving) return null
  const at = moving.key.indexOf(':')
  const kind = moving.key.slice(0, at)
  const id = moving.key.slice(at + 1)
  const parts = kind === 'part' ? moving.board.parts.filter(p => p.ref === id) : []
  const wires = kind === 'wire' ? moving.board.wires.filter(w => w.id === id) : []
  const board: BoardFile = { ...moving.board, parts, wires, trails: [] }
  return {
    board,
    placed: parts.map(placePart),
    tint: moving.ok ? null : REFUSED,
    ghost: moving.ghost ?? null,
    folds: moving.folds ?? false
  }
}

/**
 * An SVG `matrix(a b c d e f)` taking `geo.pt(h)` to `geo.pt(mapHole(h, p))` for every hole: the
 * affine map fixed by the grabbed hole and its neighbours one column and one row on. It needs no
 * hole names, so it draws a copy past the board's top or left edge; mirrored sides need no case.
 */
export function ghostTransform(geo: Pick<Geo, 'pt'>, p: Placement): string {
  const at = (h: Hole) => geo.pt(h)
  const right = { col: p.from.col + 1, row: p.from.row }
  const down = { col: p.from.col, row: p.from.row + 1 }
  const o = at(p.from)
  const x = { x: at(right).x - o.x, y: at(right).y - o.y }
  const y = { x: at(down).x - o.x, y: at(down).y - o.y }
  const o2 = at(mapHole(p.from, p))
  const x2 = { x: at(mapHole(right, p)).x - o2.x, y: at(mapHole(right, p)).y - o2.y }
  const y2 = { x: at(mapHole(down, p)).x - o2.x, y: at(mapHole(down, p)).y - o2.y }
  // M takes x to x2 and y to y2: M = [x2 y2] · [x y]⁻¹.
  const det = x.x * y.y - y.x * x.y
  const a = (x2.x * y.y - y2.x * x.y) / det
  const c = (y2.x * x.x - x2.x * y.x) / det
  const b = (x2.y * y.y - y2.y * x.y) / det
  const d = (y2.y * x.x - x2.y * y.x) / det
  const e = o2.x - (a * o.x + c * o.y)
  const f = o2.y - (b * o.x + d * o.y)
  return `matrix(${a} ${b} ${c} ${d} ${e} ${f})`
}
