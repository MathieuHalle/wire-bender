// Board features in the 3D scene: a no-go patch on each blocked hole and a ring round each
// mounting hole's clearance, on both surfaces. The openings themselves are in the slab
// (`boardGeometry`). Pure: no Node, DOM or three.js.
import { holeExists } from '../boardShape'
import { blockedZones, mountingShapes } from '../features'
import { holeMm, parseHole } from '../holes'
import type { BoardFile } from '../schema'
import { BOARD_THICKNESS_MM, BREADBOARD_THICKNESS_MM, COLORS } from './dims'
import type { Prim, V3 } from './types'

const LIFT = 0.02

export function featurePrims(board: BoardFile): Prim[] {
  const b = board.board
  const p = b.pitchMm
  const bottom = -(b.type === 'breadboard' ? BREADBOARD_THICKNESS_MM : BOARD_THICKNESS_MM)
  const surfaces = b.type === 'breadboard' ? [LIFT] : [LIFT, bottom - LIFT]
  const out: Prim[] = []
  const seen = new Set<string>()
  for (const z of blockedZones(b, h => holeExists(b, h)))
    for (const n of z.holes) {
      if (seen.has(n)) continue
      seen.add(n)
      let m
      try {
        m = holeMm(parseHole(n), p)
      } catch {
        continue
      }
      for (const y of surfaces)
        out.push({ kind: 'box', center: [m.x, y, m.y], size: [p * 0.9, LIFT, p * 0.9], color: COLORS.noGo, tag: { kind: 'board', id: 'board', label: `blocked: ${z.reason}` } })
    }
  for (const mh of b.mountingHoles ?? []) {
    const c = mountingShapes(mh).clearance
    if (!mh.clearanceMm || c.kind !== 'circle') continue
    for (const y of surfaces) {
      const points: V3[] = Array.from({ length: 49 }, (_, i) => [c.cx + c.r * Math.cos((i / 48) * 2 * Math.PI), y, c.cy + c.r * Math.sin((i / 48) * 2 * Math.PI)])
      out.push({ kind: 'tube', points, radius: 0.12, color: COLORS.mountRing, tag: { kind: 'board', id: 'board', label: `mounting hole ${mh.diameterMm} mm, clearance ${mh.clearanceMm} mm` } })
    }
  }
  return out
}
