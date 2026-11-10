import { describe, expect, it } from 'vitest'
import { benchModel } from '~core/bench/sheet'
import { FOOTPRINT_PITCH_MM, FOOTPRINTS, placePart } from '~core/footprints'
import { holeMm } from '~core/holes'
import { buildScene, COLORS, type Prim } from '~core/scene3d'
import type { Part } from '~core/schema'
import { mk } from './helpers'

const scene = (parts: Part[]) => buildScene(mk({ board: { cols: 30, rows: 30 }, parts }))
const bodyOf = (prims: Prim[], ref: string) => prims.filter(p => p.tag.kind === 'part' && p.tag.id === ref)
const mm = (hole: string) => {
  const pp = placePart({ ref: 'T', footprint: 'axial', at: hole, rotation: 0, pins: {} })
  const m = holeMm(pp.pins[0]!.hole, FOOTPRINT_PITCH_MM)
  return { x: m.x, z: m.y }
}
/** The centre of an extrude's outline. */
const centreOf = (p: Prim) => {
  if (p.kind !== 'extrude') throw new Error('not an extrude')
  return { x: p.outline.reduce((s, q) => s + q.x, 0) / p.outline.length, z: p.outline.reduce((s, q) => s + q.z, 0) / p.outline.length }
}
const dist = (a: { x: number, z: number }, b: { x: number, z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

describe('LEDs', () => {
  it('3 and 5 mm: round, one hole between the leads, cathode flat at b', () => {
    for (const [id, d] of [['led-3mm', 3.8], ['led-5mm', 5.8]] as const) {
      const fp = FOOTPRINTS[id]!
      expect(fp.twoLead).toEqual({ minSpan: 1, maxSpan: 1 })
      expect(fp.body.round).toBe(true)
      expect(fp.body.rect.w).toBe(d)
      expect(fp.mark).toBe('flat-b')
    }
  })

  it('the body circle is centred between the leads, either way round', () => {
    for (const [at, to] of [['C3', 'C4'], ['C3', 'D3']]) {
      const r = placePart({ ref: 'D1', footprint: 'led-5mm', at, to, rotation: 0, pins: {} }).bodyRectMm
      const a = mm(at)
      const b = mm(to)
      expect(r.x + r.w / 2).toBeCloseTo((a.x + b.x) / 2)
      expect(r.y + r.h / 2).toBeCloseTo((a.z + b.z) / 2)
      expect(r.w).toBeCloseTo(5.8)
      expect(r.h).toBeCloseTo(5.8)
    }
  })

  it('the rim\'s flat is on the cathode (b) side in 3D', () => {
    const s = scene([{ ref: 'D1', footprint: 'led-5mm', at: 'E5', to: 'F5', rotation: 0, pins: {} }])
    const rim = bodyOf(s.prims, 'D1').find(p => p.kind === 'extrude')!
    // The cut-off side pulls the outline's centre away from b.
    expect(dist(centreOf(rim), mm('E5'))).toBeLessThan(dist(centreOf(rim), mm('F5')))
  })

  it('takes its colour from the value or label, red when they say none', () => {
    const colorOf = (over: Partial<Part>) => {
      const s = scene([{ ref: 'D1', footprint: 'led-3mm', at: 'E5', rotation: 0, pins: {}, ...over }])
      return bodyOf(s.prims, 'D1').find(p => p.kind === 'lathe')!.color
    }
    expect(colorOf({ value: 'green' })).toBe(COLORS.ledGreen)
    expect(colorOf({ label: 'LED blue' })).toBe(COLORS.ledBlue)
    expect(colorOf({})).toBe(COLORS.ledRed)
  })

  it('stands on 1 mm of leg', () => {
    const s = scene([{ ref: 'D1', footprint: 'led-3mm', at: 'E5', rotation: 0, pins: {} }])
    const low = Math.min(...bodyOf(s.prims, 'D1').map(p => p.kind === 'extrude' ? p.y0 : p.kind === 'lathe' ? Math.min(...p.profile.map(q => q.y)) : 0))
    expect(low).toBeCloseTo(1)
  })
})

describe('electrolytic capacitors', () => {
  it('has the sizes, spans and heights', () => {
    expect(FOOTPRINTS['cap-elec-5x11']).toMatchObject({ twoLead: { minSpan: 1, maxSpan: 1 }, body: { heightMm: 11.5, round: true }, mark: 'minus-b' })
    expect(FOOTPRINTS['cap-elec-6.3x11']!.twoLead).toEqual({ minSpan: 1, maxSpan: 1 })
    expect(FOOTPRINTS['cap-elec-8x12']!.twoLead).toEqual({ minSpan: 2, maxSpan: 2 })
    expect(FOOTPRINTS['cap-elec-10x20']!.body.heightMm).toBe(20.5)
    expect(FOOTPRINTS['cap-elec-7x7']).toBeUndefined()
  })

  it('the minus stripe is on the b side', () => {
    const s = scene([{ ref: 'C1', footprint: 'cap-elec-8x12', at: 'H8', to: 'H10', rotation: 0, pins: {} }])
    const stripe = bodyOf(s.prims, 'C1').find(p => p.kind === 'extrude')!
    expect(stripe.color).toBe(COLORS.capElecStripe)
    expect(dist(centreOf(stripe), mm('H10'))).toBeLessThan(dist(centreOf(stripe), mm('H8')))
  })
})

describe('bench sheet orientation', () => {
  it('names the LED cathode and the electrolytic minus by hole', () => {
    const m = benchModel(mk({
      board: { cols: 30, rows: 30 },
      parts: [
        { ref: 'D1', footprint: 'led-5mm', at: 'E5', to: 'F5', rotation: 0, pins: {} },
        { ref: 'C1', footprint: 'cap-elec-6.3x11', at: 'H8', to: 'H9', rotation: 0, pins: {} }
      ]
    }))
    const text = JSON.stringify(m)
    expect(text).toContain('cathode (flat side) at F5')
    expect(text).toContain('minus (stripe) at H9')
  })
})
