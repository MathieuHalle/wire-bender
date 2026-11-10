import { describe, expect, it } from 'vitest'
import { bodyHeightMm, FOOTPRINT_PITCH_MM, FOOTPRINTS, placePart, type Footprint } from '~core/footprints'
import { holeMm } from '~core/holes'
import { buildScene, type Prim, type V3 } from '~core/scene3d'
import type { Part } from '~core/schema'
import { mk } from './helpers'

const LEG_BOTTOM = -1.6 - 1.5

/** The highest point of a prim, radius included. */
function topOf(p: Prim): number {
  switch (p.kind) {
    case 'box': return p.center[1] + p.size[1] / 2
    case 'cylinder': {
      const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) || 1
      const dy = Math.abs(p.b[1] - p.a[1]) / len
      return Math.max(p.a[1], p.b[1]) + p.radius * Math.sqrt(Math.max(0, 1 - dy * dy))
    }
    case 'tube': return Math.max(...p.points.map(q => q[1])) + p.radius
    case 'cone': return p.up === 1 ? p.base[1] + p.height : p.base[1]
  }
}
const pointsOf = (p: Prim): V3[] => p.kind === 'cylinder' ? [p.a, p.b] : p.kind === 'tube' ? p.points : []

/** One id per shape, and the ends of every family. */
function sample(): Footprint[] {
  const byShape = new Map<string, Footprint[]>()
  for (const fp of Object.values(FOOTPRINTS)) byShape.set(fp.shape, [...(byShape.get(fp.shape) ?? []), fp])
  return [...byShape.values()].flatMap(list => [...new Set([list[0]!, list[1] ?? list[0]!, list.at(-1)!])])
}

/** A two-lead part lies along its default span; its lead direction comes from `at`/`to`, not rotation. */
const partOf = (fp: Footprint, rotation: 0 | 90 | 180 | 270, flip: boolean): Part => fp.twoLead
  ? { ref: 'X1', footprint: fp.id, at: 'Z30', rotation: 0, pins: {} }
  : { ref: 'X1', footprint: fp.id, at: 'Z30', rotation, flip, pins: {} }

describe('every footprint in 3D', () => {
  const cases = sample().flatMap(fp => fp.twoLead
    ? [{ fp, rotation: 0 as const, flip: false }]
    : ([0, 90, 180, 270] as const).flatMap(rotation => [false, true].map(flip => ({ fp, rotation, flip }))))

  it.each(cases.map(c => [`${c.fp.id} r${c.rotation}${c.flip ? ' flipped' : ''}`, c] as const))('%s: legs at its holes, top at its height', (_, { fp, rotation, flip }) => {
    const part = partOf(fp, rotation, flip)
    const s = buildScene(mk({ board: { cols: 70, rows: 70 }, parts: [part] }))
    expect(s.skipped).toEqual([])
    const pp = placePart(part)
    const legs = s.prims.filter(p => p.tag.kind === 'leg' && p.kind !== 'box')
    expect(legs).toHaveLength(pp.pins.length)
    for (const pin of pp.pins) {
      const leg = legs.find(l => l.tag.id === `X1.${pin.name}`)
      expect(leg, pin.name).toBeDefined()
      const m = holeMm(pin.hole, FOOTPRINT_PITCH_MM)
      const low = pointsOf(leg!).reduce((a, q) => q[1] < a[1] ? q : a)
      expect(low[1]).toBeCloseTo(LEG_BOTTOM)
      expect(low[0]).toBeCloseTo(m.x)
      expect(low[2]).toBeCloseTo(m.y)
    }
    const body = s.prims.filter(p => p.tag.kind === 'part')
    expect(body.length).toBeGreaterThan(0)
    const top = Math.max(...body.map(topOf))
    expect(Math.abs(top - bodyHeightMm(part, pp.fp)), `top ${top}`).toBeLessThanOrEqual(0.05)
    for (const v of [...s.bounds.min, ...s.bounds.max]) expect(Number.isFinite(v)).toBe(true)
  })
})
