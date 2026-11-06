import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseBoard, type BoardFile, type Part } from '~core/schema'
import { placePart, FOOTPRINT_PITCH_MM } from '~core/footprints'
import { holeMm, parseHole } from '~core/holes'
import { buildScene, type Prim, type V3 } from '~core/scene3d'
import { mk } from './helpers'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const LEG_BOTTOM = -1.6 - 1.5
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6

/** Every point of a prim, for y extents. */
function ys(p: Prim): number[] {
  switch (p.kind) {
    case 'box': return [p.center[1] - p.size[1] / 2, p.center[1] + p.size[1] / 2]
    case 'cylinder': return [p.a[1], p.b[1]]
    case 'tube': return p.points.map(q => q[1])
    case 'cone': return [p.base[1], p.base[1] + p.up * p.height]
  }
}
const pointsOf = (p: Prim): V3[] => p.kind === 'cylinder' ? [p.a, p.b] : p.kind === 'tube' ? p.points : []

const pinXZ = (part: Part, pin: string) => {
  const h = placePart(part).pins.find(x => x.name === pin)!.hole
  const m = holeMm(h, FOOTPRINT_PITCH_MM)
  return { x: m.x, z: m.y }
}

describe('scene3d parts', () => {
  const b = board2()
  const s = buildScene(b)
  const bodies = (ref: string) => s.prims.filter(p => p.tag.kind === 'part' && p.tag.id === ref)
  const legs = (ref: string) => s.prims.filter(p => p.tag.kind === 'leg' && p.tag.id.split('.')[0] === ref)

  it('every part has a body and one leg per pin', () => {
    expect(s.skipped).toEqual([])
    for (const part of b.parts) {
      expect(bodies(part.ref).length, part.ref).toBeGreaterThanOrEqual(1)
      expect(legs(part.ref), part.ref).toHaveLength(placePart(part).pins.length)
      const bodyBottom = Math.min(...bodies(part.ref).flatMap(ys))
      for (const leg of legs(part.ref)) {
        const pin = leg.tag.id.split('.')[1]!
        const { x, z } = pinXZ(part, pin)
        const pts = pointsOf(leg)
        expect(pts.length, leg.tag.id).toBeGreaterThanOrEqual(2)
        // Lowest point is under the board, at the pin hole.
        const low = pts.reduce((m, q) => q[1] < m[1] ? q : m)
        expect(low[1]).toBeCloseTo(LEG_BOTTOM)
        expect(low[0]).toBeCloseTo(x)
        expect(low[2]).toBeCloseTo(z)
        // It passes through the hole: a point at the hole's x,z at or above the top surface.
        expect(pts.some(q => close(q[0], x) && close(q[2], z) && q[1] >= 0), leg.tag.id).toBe(true)
        if (leg.kind === 'cylinder') expect(Math.max(leg.a[1], leg.b[1])).toBeLessThanOrEqual(bodyBottom + 1e-9)
        expect(leg.tag.net).toBe(part.pins[pin] ?? null)
      }
      for (const body of bodies(part.ref)) expect(body.tag.net).toBeUndefined()
    }
  })

  it('NC pins have legs tagged net null', () => {
    const u1 = legs('U1')
    expect(u1.find(l => l.tag.id === 'U1.1')!.tag.net).toBeNull()
    expect(u1.find(l => l.tag.id === 'U1.2')!.tag.net).toBe('IN_A')
  })

  it('DIP-8 box has footprint height and sits above the board', () => {
    const box = bodies('U1').find(p => p.kind === 'box')
    expect(box?.kind).toBe('box')
    if (box?.kind !== 'box') return
    expect(box.size[1]).toBeCloseTo(4.5)
    expect(box.center[1]).toBeGreaterThan(0)
    expect(box.center[1] - box.size[1] / 2).toBeCloseTo(0.5)
  })

  it('lying axial is a 2.5 cylinder along the lead axis, body-rect long', () => {
    const part = b.parts.find(p => p.ref === 'RGA')!
    const cyl = bodies('RGA').find(p => p.kind === 'cylinder')
    expect(cyl?.kind).toBe('cylinder')
    if (cyl?.kind !== 'cylinder') return
    expect(cyl.radius * 2).toBeCloseTo(2.5)
    const r = placePart(part).bodyRectMm
    const len = Math.hypot(cyl.b[0] - cyl.a[0], cyl.b[1] - cyl.a[1], cyl.b[2] - cyl.a[2])
    expect(len).toBeCloseTo(Math.max(r.w, r.h))
    const a = pinXZ(part, 'a')
    const bb = pinXZ(part, 'b')
    // Parallel to a -> b and horizontal, resting on the board.
    const ax = [cyl.b[0] - cyl.a[0], cyl.b[2] - cyl.a[2]]
    const lx = [bb.x - a.x, bb.z - a.z]
    expect(ax[0]! * lx[1]! - ax[1]! * lx[0]!).toBeCloseTo(0)
    expect(cyl.a[1]).toBeCloseTo(1.25)
    expect(cyl.b[1]).toBeCloseTo(1.25)
  })

  it('standing axial is a vertical 7 mm cylinder over lead a', () => {
    const part = b.parts.find(p => p.ref === 'RPA')!
    const cyl = bodies('RPA').find(p => p.kind === 'cylinder')
    expect(cyl?.kind).toBe('cylinder')
    if (cyl?.kind !== 'cylinder') return
    const a = pinXZ(part, 'a')
    for (const q of [cyl.a, cyl.b]) {
      expect(q[0]).toBeCloseTo(a.x)
      expect(q[2]).toBeCloseTo(a.z)
    }
    expect(Math.min(cyl.a[1], cyl.b[1])).toBeCloseTo(0)
    expect(Math.abs(cyl.b[1] - cyl.a[1])).toBeCloseTo(7)
    // Lead b loops over the top.
    const lb = legs('RPA').find(l => l.tag.id === 'RPA.b')!
    expect(lb.kind).toBe('tube')
    expect(Math.max(...ys(lb))).toBeGreaterThan(7)
  })

  it('every leg is soldered underneath', () => {
    const cones = s.prims.filter(p => p.kind === 'cone' && p.tag.kind === 'joint')
    for (const part of b.parts)
      for (const pin of placePart(part).pins) {
        const m = holeMm(pin.hole, FOOTPRINT_PITCH_MM)
        const at = cones.filter(c => c.kind === 'cone' && c.up === -1 && close(c.base[0], m.x) && close(c.base[2], m.y))
        expect(at, `${part.ref}.${pin.name}`).toHaveLength(1)
        const c = at[0]!
        if (c.kind !== 'cone') continue
        expect(c.base[1]).toBeCloseTo(-1.6)
        expect(c.radius * 2).toBeCloseTo(1.8)
        expect(c.height).toBeCloseTo(0.9)
      }
  })

  it('one solder cone per hole and side', () => {
    // Two parts sharing a hole: still one cone there.
    const s2 = buildScene(mk({
      parts: [
        { ref: 'R1', footprint: 'axial', at: 'A1', to: 'A4', rotation: 0, pins: { a: 'N1', b: 'N2' } },
        { ref: 'R2', footprint: 'axial', at: 'A4', to: 'A7', rotation: 0, pins: { a: 'N2', b: 'N3' } }
      ]
    }))
    const m = holeMm(parseHole('A4'), FOOTPRINT_PITCH_MM)
    const cones = s2.prims.filter(p => p.kind === 'cone' && close(p.base[0], m.x) && close(p.base[2], m.y))
    expect(cones).toHaveLength(1)
  })

  it('unknown footprint is skipped and reported', () => {
    const raw = JSON.parse(JSON.stringify(b)) as BoardFile
    raw.parts.push({ ref: 'X1', footprint: 'nope', at: 'A1', rotation: 0, pins: {} })
    const s3 = buildScene(raw)
    expect(s3.prims.filter(p => p.tag.id.split('.')[0] === 'X1')).toEqual([])
    expect(s3.skipped).toHaveLength(1)
    expect(s3.skipped[0]).toContain('X1')
    expect(s3.skipped[0]).toContain('nope')
    expect(bodies('U1').length).toBeGreaterThan(0)
    expect(s3.prims.filter(p => p.tag.kind === 'part' && p.tag.id === 'U1').length).toBeGreaterThan(0)
  })

  it('bounds cover the legs and the tallest part', () => {
    expect(s.bounds.min[1]).toBeLessThanOrEqual(LEG_BOTTOM + 1e-9)
    expect(s.bounds.max[1]).toBeGreaterThanOrEqual(15.5)
  })
})
