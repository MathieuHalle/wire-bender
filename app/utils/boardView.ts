// View helpers for the board drawing: geometry (mm, optionally mirrored), net colours,
// and lit sets for a highlighted group. Pure functions over core/ results (which group
// sits at a hole is core's `groupAtHole`).
import { holeKey, holeMm, type Hole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import type { Conductor, Connectivity } from '~core/connectivity'

export type Tool = 'inspect' | 'pencil' | 'erase' | 'joint'
export type Group = Connectivity['groups'][number]

/** Board mm -> drawing mm. Mirrored flips x so the bottom reads as seen from below. */
export interface Geo {
  pitch: number
  cols: number
  rows: number
  /** x of the last column centre. */
  span: number
  mirrored: boolean
  x(x: number): number
  pt(h: Hole): { x: number, y: number }
  rect(r: { x: number, y: number, w: number, h: number }): { x: number, y: number, w: number, h: number }
}

export function makeGeo(board: BoardFile, mirrored: boolean): Geo {
  const pitch = board.board.pitchMm
  const span = (board.board.cols - 1) * pitch
  const x = (v: number) => (mirrored ? span - v : v)
  return {
    pitch,
    cols: board.board.cols,
    rows: board.board.rows,
    span,
    mirrored,
    x,
    pt(h) {
      const m = holeMm(h, pitch)
      return { x: x(m.x), y: m.y }
    },
    rect(r) {
      return { x: mirrored ? span - r.x - r.w : r.x, y: r.y, w: r.w, h: r.h }
    }
  }
}

export const FALLBACK_NET = '#8a7a55'
export const NO_NET = '#9aa59f'

export function netColor(board: BoardFile, net: string | null | undefined): string {
  if (!net) return NO_NET
  const n = board.nets[net]
  return n?.color ?? (n?.class ? board.netClasses[n.class]?.color : undefined) ?? FALLBACK_NET
}

export function conductorKey(c: Conductor): string {
  return c.kind === 'pad' ? `pad:${holeKey(c.hole)}:${c.side}` : `${c.kind}:${c.id}`
}

/** What a highlighted group lights up, as lookup sets. */
export interface Lit {
  ids: Set<string> // 'trail:T1', 'wire:W3', 'lead:U1.6'
  pads: Set<string> // 'col,row|side'
}

export function litOf(group: Group | null): Lit | null {
  if (!group) return null
  const ids = new Set<string>()
  const pads = new Set<string>()
  for (const c of group.conductors) {
    if (c.kind === 'pad') pads.add(`${holeKey(c.hole)}|${c.side}`)
    else ids.add(`${c.kind}:${c.id}`)
  }
  return { ids, pads }
}

/** The side to add a proposed joint on: the side of the trail the contact rule names at that hole. */
export function jointSide(board: BoardFile, conn: Connectivity, hole: Hole): Side | null {
  const k = holeKey(hole)
  for (const pj of conn.proposedJoints) {
    if (holeKey(pj.hole) !== k) continue
    const t = board.trails.find(x => x.id === pj.trailId)
    if (t) return t.side
  }
  return null
}
