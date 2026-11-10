// Outlines and profiles for the `extrude` and `lathe` prims, in board mm (x right, z down
// the rows). Pure geometry: no three.js here.
import type { Rect } from '../footprints'
import type { XZ } from './types'

const ARC_STEPS = 6

/** Points round a quarter circle about c from angle a0 to a1 (radians), both ends included. */
function arc(c: XZ, radius: number, a0: number, a1: number, steps: number): XZ[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + (a1 - a0) * (i / steps)
    return { x: c.x + radius * Math.cos(a), z: c.z + radius * Math.sin(a) }
  })
}

/** A board-mm rect (x, y as x, z) with its corners rounded to `radius` (clamped to half the short side). */
export function roundedRect(r: Rect, radius: number, steps = ARC_STEPS): XZ[] {
  const k = Math.max(0, Math.min(radius, r.w / 2, r.h / 2))
  if (k === 0) return [{ x: r.x, z: r.y }, { x: r.x + r.w, z: r.y }, { x: r.x + r.w, z: r.y + r.h }, { x: r.x, z: r.y + r.h }]
  const x0 = r.x + k
  const x1 = r.x + r.w - k
  const z0 = r.y + k
  const z1 = r.y + r.h - k
  const h = Math.PI / 2
  return dedup([
    ...arc({ x: x1, z: z0 }, k, -h, 0, steps),
    ...arc({ x: x1, z: z1 }, k, 0, h, steps),
    ...arc({ x: x0, z: z1 }, k, h, 2 * h, steps),
    ...arc({ x: x0, z: z0 }, k, 2 * h, 3 * h, steps)
  ])
}

/** The outline without a point equal to the one before it (the last compared with the first). */
function dedup(pts: XZ[]): XZ[] {
  const same = (a: XZ, b: XZ) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9
  const out = pts.filter((q, i) => i === 0 || !same(q, pts[i - 1]!))
  return out.length > 1 && same(out[0]!, out.at(-1)!) ? out.slice(0, -1) : out
}

/**
 * A circle of `radius` about c cut by a straight edge `flatAt` mm from c on the side the unit
 * vector `flatDir` points to (0 < flatAt < radius): a TO-92's D shape, an LED's flat rim.
 */
export function dOutline(c: XZ, radius: number, flatDir: XZ, flatAt: number, steps = 24): XZ[] {
  const d = Math.max(-radius, Math.min(radius, flatAt))
  const half = Math.acos(d / radius) // the arc keeps the angles more than `half` from flatDir
  const base = Math.atan2(flatDir.z, flatDir.x)
  return arc(c, radius, base + half, base + 2 * Math.PI - half, steps)
}

/** A circle as an outline, for a round band or disc. */
export function circleOutline(c: XZ, radius: number, steps = 24): XZ[] {
  return arc(c, radius, 0, 2 * Math.PI * (1 - 1 / steps), steps - 1)
}
