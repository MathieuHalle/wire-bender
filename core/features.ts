// Board features inside the outline: cutouts (material removed: a slot, a window, a round hole for
// a pot shaft) and mounting holes (drilled for a screw or a standoff). Holes under either are
// missing (`holeExists` asks here); holes within a mounting hole's clearance are blocked, as if
// listed in `board.blocked` with the reason "mounting hole". Positions are board mm, A1's centre
// at (0, 0), x to the right and y down (`holeMm`).
import { holeKey, holeMm, holeName, parseHole, type Hole } from './holes'
import type { BoardFile, Cutout, HoleName, MountingHole } from './schema'

type Board = BoardFile['board']

/** A hole is missing when its centre is closer than this to a cutout (in pitches): the shapes' rim. */
const RIM = 0.25

export type FeatureShape = { kind: 'rect', x0: number, y0: number, x1: number, y1: number } | { kind: 'circle', cx: number, cy: number, r: number }

/** A cutout as a shape in board mm. A grid cutout runs half a pitch past its corner holes, like a notch. */
export function cutoutShape(b: Board, c: Cutout): FeatureShape {
  const p = b.pitchMm
  if (c.kind === 'grid') {
    const a = holeMm(parseHole(c.from), p)
    const z = holeMm(parseHole(c.to), p)
    return { kind: 'rect', x0: Math.min(a.x, z.x) - p / 2, y0: Math.min(a.y, z.y) - p / 2, x1: Math.max(a.x, z.x) + p / 2, y1: Math.max(a.y, z.y) + p / 2 }
  }
  if (c.kind === 'rect')
    return { kind: 'rect', x0: c.x - c.widthMm / 2, y0: c.y - c.heightMm / 2, x1: c.x + c.widthMm / 2, y1: c.y + c.heightMm / 2 }
  return { kind: 'circle', cx: c.x, cy: c.y, r: c.diameterMm / 2 }
}

/** A mounting hole's drilled circle, and its clearance circle (screw head, standoff). */
export function mountingShapes(m: MountingHole): { hole: FeatureShape, clearance: FeatureShape } {
  return {
    hole: { kind: 'circle', cx: m.x, cy: m.y, r: m.diameterMm / 2 },
    clearance: { kind: 'circle', cx: m.x, cy: m.y, r: m.diameterMm / 2 + (m.clearanceMm ?? 0) }
  }
}

/** Distance from a point to the shape: negative inside (to its nearest edge), 0 on it. */
export function signedDistance(s: FeatureShape, x: number, y: number): number {
  if (s.kind === 'circle') return Math.hypot(x - s.cx, y - s.cy) - s.r
  const dx = Math.max(s.x0 - x, 0, x - s.x1)
  const dy = Math.max(s.y0 - y, 0, y - s.y1)
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy)
  return -Math.min(x - s.x0, s.x1 - x, y - s.y0, s.y1 - y)
}

/** Every cutout and drilled mounting hole, as shapes. */
export function openings(b: Board): FeatureShape[] {
  // A grid cutout with a bad hole name is skipped (the format reports it): never a throw.
  const cut = (b.cutouts ?? []).flatMap((c) => {
    try {
      return [cutoutShape(b, c)]
    } catch {
      return []
    }
  })
  return [...cut, ...(b.mountingHoles ?? []).map(m => mountingShapes(m).hole)]
}

/** True when a cutout or a mounting hole takes this hole away (its centre within ¼ pitch of one). */
export function underOpening(b: Board, h: Hole): boolean {
  if (!b.cutouts?.length && !b.mountingHoles?.length) return false
  const m = holeMm(h, b.pitchMm)
  return openings(b).some(s => signedDistance(s, m.x, m.y) < RIM * b.pitchMm)
}

/**
 * The board's no-go zones: `blocked` as written, then one zone per mounting hole with clearance,
 * holding the holes within it that the hole itself doesn't take away (`exists` says which do).
 */
export function blockedZones(b: Board, exists: (h: Hole) => boolean): { holes: HoleName[], reason: string }[] {
  const out = [...b.blocked]
  for (const m of b.mountingHoles ?? []) {
    if (!m.clearanceMm) continue
    const c = mountingShapes(m).clearance
    const holes: HoleName[] = []
    if (c.kind !== 'circle') continue
    const p = b.pitchMm
    for (let row = Math.max(1, Math.floor((c.cy - c.r) / p) + 1); row <= Math.min(b.rows, Math.ceil((c.cy + c.r) / p) + 1); row++)
      for (let col = Math.max(1, Math.floor((c.cx - c.r) / p) + 1); col <= Math.min(b.cols, Math.ceil((c.cx + c.r) / p) + 1); col++) {
        const h = { col, row }
        const q = holeMm(h, p)
        if (exists(h) && signedDistance(c, q.x, q.y) < 0) holes.push(holeName(h))
      }
    if (holes.length) out.push({ holes, reason: 'mounting hole' })
  }
  return out
}

/** Hole key → why it is blocked (the first zone naming it). */
export function blockedReasons(b: Board, exists: (h: Hole) => boolean): Map<string, string> {
  const m = new Map<string, string>()
  for (const z of blockedZones(b, exists))
    for (const n of z.holes) {
      try {
        const k = holeKey(parseHole(n))
        if (!m.has(k)) m.set(k, z.reason)
      } catch {
        // a bad name: the format reports it
      }
    }
  return m
}
