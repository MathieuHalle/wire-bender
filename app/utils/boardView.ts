// View helpers for the board drawing: geometry (mm, optionally mirrored), net colours,
// and which connectivity group sits at a hole. Pure functions over core/ results.
import { holeKey, holeMm, parseHole, straightRun, type Hole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import type { PlacedPart } from '~core/footprints'
import type { Conductor, Connectivity } from '~core/connectivity'

export type Tool = 'select' | 'pencil' | 'erase' | 'joint'
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

/** Holes on a polyline, bends included, no repeats. */
export function polyHoles(points: Hole[]): Hole[] {
  if (points.length === 1) return [points[0]!]
  const seen = new Map<string, Hole>()
  for (let i = 0; i + 1 < points.length; i++)
    for (const h of straightRun(points[i]!, points[i + 1]!)) seen.set(holeKey(h), h)
  return [...seen.values()]
}

/**
 * `holeKey|side` -> group index. Most specific first: the pad on that side, then
 * what goes through the hole (lead, wire end), then a trail or laid wire lying over it.
 */
export function holeGroups(board: BoardFile, conn: Connectivity, placed: PlacedPart[]): Map<string, number> {
  const groupOf = new Map<string, number>()
  conn.groups.forEach((g, i) => g.conductors.forEach(c => groupOf.set(conductorKey(c), i)))
  const out = new Map<string, number>()
  const set = (h: Hole, side: Side, gi: number | undefined) => {
    const k = `${holeKey(h)}|${side}`
    if (gi !== undefined && !out.has(k)) out.set(k, gi)
  }
  for (const [k, gi] of groupOf) {
    if (!k.startsWith('pad:')) continue
    const [, key, side] = k.split(':') as [string, string, Side]
    const [col, row] = key.split(',').map(Number) as [number, number]
    set({ col, row }, side, gi)
  }
  for (const p of placed)
    for (const pin of p.pins)
      for (const side of ['top', 'bottom'] as const) set(pin.hole, side, groupOf.get(`lead:${p.part.ref}.${pin.name}`))
  for (const w of board.wires) {
    const pts = w.points.map(parseHole)
    for (const end of [pts[0]!, pts[pts.length - 1]!])
      for (const side of ['top', 'bottom'] as const) set(end, side, groupOf.get(`wire:${w.id}`))
  }
  for (const t of board.trails)
    for (const h of polyHoles(t.points.map(parseHole))) set(h, t.side, groupOf.get(`trail:${t.id}`))
  for (const w of board.wires)
    if (w.kind === 'laid')
      for (const h of polyHoles(w.points.map(parseHole))) set(h, w.side, groupOf.get(`wire:${w.id}`))
  return out
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
