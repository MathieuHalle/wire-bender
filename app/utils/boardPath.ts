// The board as one SVG path, as a side draws it: its outline (rectangle, round, cut corners,
// grown round a mounting hole) with its openings (cutouts, drilled mounting holes) as holes in it,
// for `fill-rule="evenodd"`. Also the mounting holes' clearance rings and the no-go patches.
import { holeExists, shapeOutline } from '~core/boardShape'
import { blockedZones, cutoutShape, mountingShapes, type FeatureShape } from '~core/features'
import { parseHole } from '~core/holes'
import type { BoardFile } from '~core/schema'
import type { Geo } from './boardView'

const circlePath = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`

/** A feature shape (board mm) as a closed subpath in this side's drawing mm. */
function shapePath(s: FeatureShape, geo: Geo): string {
  if (s.kind === 'circle') return circlePath(geo.x(s.cx), geo.y(s.cy), s.r)
  const xs = [geo.x(s.x0), geo.x(s.x1)]
  const ys = [geo.y(s.y0), geo.y(s.y1)]
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  return `M${x0} ${y0}H${x1}V${y1}H${x0}Z`
}

export function boardPath(board: BoardFile, geo: Geo): string {
  const o = shapeOutline(board.board, geo)
  const e = geo.edge
  const outline = !o
    ? `M${e.x0} ${e.y0}H${e.x1}V${e.y1}H${e.x0}Z`
    : o.kind === 'circle'
      ? circlePath(o.cx, o.cy, o.r)
      : `M${o.points.map(p => `${p.x} ${p.y}`).join('L')}Z`
  const holes = [
    ...(board.board.cutouts ?? []).map(c => cutoutShape(board.board, c)),
    ...(board.board.mountingHoles ?? []).map(m => mountingShapes(m).hole)
  ]
  return [outline, ...holes.map(s => shapePath(s, geo))].join('')
}

/** Each mounting hole's clearance ring (none without clearance), in drawing mm. */
export function mountRings(board: BoardFile, geo: Geo): { cx: number, cy: number, r: number }[] {
  return (board.board.mountingHoles ?? []).filter(m => m.clearanceMm).map((m) => {
    const c = mountingShapes(m).clearance as { cx: number, cy: number, r: number }
    return { cx: geo.x(c.cx), cy: geo.y(c.cy), r: c.r }
  })
}

/** The blocked holes (as written, and round mounting holes), each with its zone's reason, in drawing mm. */
export function noGoCells(board: BoardFile, geo: Geo): { k: string, x: number, y: number, reason: string }[] {
  const exists = (h: { col: number, row: number }) => holeExists(board.board, h)
  const seen = new Set<string>()
  const out: { k: string, x: number, y: number, reason: string }[] = []
  for (const z of blockedZones(board.board, exists))
    for (const n of z.holes) {
      if (seen.has(n)) continue
      seen.add(n)
      try {
        out.push({ k: n, ...geo.pt(parseHole(n)), reason: z.reason })
      } catch {
        // a bad name: the format reports it
      }
    }
  return out
}
