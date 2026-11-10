import { describe, expect, it } from 'vitest'
import { sceneBounds, type Prim, type Scene3D } from '~core/scene3d'
import { circleOutline, dOutline, roundedRect } from '~core/scene3d/shapes'

const tag = { kind: 'part' as const, id: 'X1' }
// A tiny slab so the prims set the bounds.
const slab: Scene3D['board'] = { widthMm: 0, depthMm: 0, thicknessMm: 0, center: [1, 1, 1] }

describe('extrude and lathe bounds', () => {
  it('an extrude spans its outline from y0 to y1', () => {
    const p: Prim = { kind: 'extrude', outline: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 3 }, { x: 0, z: 3 }], y0: 1, y1: 4, color: '#000', tag }
    expect(sceneBounds(slab, [p])).toEqual({ min: [0, 1, 0], max: [2, 4, 3] })
  })

  it('a lathe spans its widest radius round the axis and its profile heights', () => {
    const p: Prim = { kind: 'lathe', axis: { x: 5, z: 5 }, profile: [{ r: 2, y: 0 }, { r: 2.5, y: 4 }, { r: 0, y: 8 }], color: '#000', tag }
    expect(sceneBounds({ ...slab, center: [5, 1, 5] }, [p])).toEqual({ min: [2.5, 0, 2.5], max: [7.5, 8, 7.5] })
  })
})

describe('outlines', () => {
  const r = { x: 1, y: 2, w: 6, h: 4 }
  it('a rounded rect stays inside its rect and touches every edge', () => {
    const pts = roundedRect(r, 1)
    for (const q of pts) {
      expect(q.x).toBeGreaterThanOrEqual(r.x - 1e-9)
      expect(q.x).toBeLessThanOrEqual(r.x + r.w + 1e-9)
      expect(q.z).toBeGreaterThanOrEqual(r.y - 1e-9)
      expect(q.z).toBeLessThanOrEqual(r.y + r.h + 1e-9)
    }
    expect(Math.min(...pts.map(q => q.x))).toBeCloseTo(r.x)
    expect(Math.max(...pts.map(q => q.x))).toBeCloseTo(r.x + r.w)
    expect(Math.min(...pts.map(q => q.z))).toBeCloseTo(r.y)
    expect(Math.max(...pts.map(q => q.z))).toBeCloseTo(r.y + r.h)
    // No corner point: the rounding cuts it off.
    expect(pts.some(q => Math.abs(q.x - r.x) < 1e-9 && Math.abs(q.z - r.y) < 1e-9)).toBe(false)
  })

  it('a radius larger than the rect is clamped; zero is the plain rect', () => {
    expect(roundedRect(r, 0)).toHaveLength(4)
    const big = roundedRect(r, 99)
    expect(Math.max(...big.map(q => q.z)) - Math.min(...big.map(q => q.z))).toBeCloseTo(4)
  })

  it('a D outline is a circle cut flat on the flat side', () => {
    const pts = dOutline({ x: 0, z: 0 }, 2.4, { x: 0, z: 1 }, 1.0)
    expect(Math.max(...pts.map(q => q.z))).toBeCloseTo(1.0)
    expect(Math.min(...pts.map(q => q.z))).toBeCloseTo(-2.4)
    for (const q of pts) expect(Math.hypot(q.x, q.z)).toBeCloseTo(2.4)
    const ends = [pts[0]!, pts.at(-1)!]
    for (const e of ends) expect(e.z).toBeCloseTo(1.0)
  })

  it('a circle outline has no repeated end point', () => {
    const pts = circleOutline({ x: 1, z: 1 }, 2, 12)
    expect(pts).toHaveLength(12)
    expect(Math.hypot(pts[0]!.x - pts.at(-1)!.x, pts[0]!.z - pts.at(-1)!.z)).toBeGreaterThan(0.1)
  })
})
