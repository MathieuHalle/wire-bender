import { describe, expect, it } from 'vitest'
import { benchModel } from '~core/bench/sheet'
import { runCheck } from '~core/check'
import { bodyHeightMm, FOOTPRINT_PITCH_MM, FOOTPRINTS, placePart, RELAY_SRD_PADS_MM, tabPlateMm } from '~core/footprints'
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

  it('the body circle is centred between the leads and keeps its size, either way round or diagonal', () => {
    for (const [at, to] of [['C3', 'C4'], ['C3', 'D3'], ['C3', 'D4'], ['E5', 'G7']]) {
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

describe('TO-92', () => {
  it('three pins in a row, its flat facing +y and turning with the part', () => {
    expect(FOOTPRINTS['to92']!.pins.map(x => [x.name, x.dx, x.dy])).toEqual([['1', 0, 0], ['2', 1, 0], ['3', 2, 0]])
    const tab = (over: Partial<Part>) => placePart({ ref: 'Q1', footprint: 'to92', at: 'E5', rotation: 0, pins: {}, ...over }).tab
    expect(tab({})).toEqual({ dx: 0, dy: 1 })
    expect(tab({ rotation: 90 })).toEqual({ dx: -1, dy: 0 })
    expect(tab({ rotation: 180 })).toEqual({ dx: 0, dy: -1 })
    expect(tab({ flip: true })).toEqual({ dx: 0, dy: 1 })
  })

  it('the 3D flat face is on the tab side, and the outer legs splay out to their holes', () => {
    const s = scene([{ ref: 'Q1', footprint: 'to92', at: 'E5', rotation: 90, pins: {} }])
    const d = bodyOf(s.prims, 'Q1').find(p => p.kind === 'extrude')!
    if (d.kind !== 'extrude') throw new Error('no body')
    // At rotation 90 the flat faces -x: the outline's straight edge (its two ends) is the
    // body rect's -x side, and the round back reaches the +x side.
    const r = placePart({ ref: 'Q1', footprint: 'to92', at: 'E5', rotation: 90, pins: {} }).bodyRectMm
    for (const end of [d.outline[0]!, d.outline.at(-1)!]) expect(end.x).toBeCloseTo(r.x)
    expect(Math.max(...d.outline.map(q => q.x))).toBeCloseTo(r.x + r.w)
    const legs = s.prims.filter(p => p.tag.kind === 'leg')
    expect(legs.filter(p => p.kind === 'tube')).toHaveLength(2)
    expect(legs.filter(p => p.kind === 'cylinder')).toHaveLength(1)
  })

  it('has no metal tab: a lead against its flat face is not a tab contact', () => {
    const q1: Part = { ref: 'Q1', footprint: 'to92', at: 'E5', rotation: 0, pins: { 1: 'A', 2: 'B', 3: 'C' } }
    expect(tabPlateMm(placePart(q1))).toBeUndefined()
    // A resistor lead in the hole just in front of the flat face (row F).
    const b = mk({ board: { cols: 30, rows: 30 }, parts: [q1, { ref: 'R1', footprint: 'axial', at: 'F6', to: 'F10', rotation: 0, pins: { a: 'D', b: 'E' } }] })
    expect(runCheck(b).findings.filter(f => f.rule === 'touchesTab')).toEqual([])
  })
})

describe('round bodies ignore standing', () => {
  it('an LED or electrolytic marked standing keeps its height, size and place', () => {
    for (const footprint of ['led-5mm', 'cap-elec-10x20']) {
      const base: Part = { ref: 'C1', footprint, at: 'E5', rotation: 0, pins: {} }
      const lying = placePart(base)
      const standing = placePart({ ...base, standing: true })
      expect(standing.bodyRectMm).toEqual(lying.bodyRectMm)
      expect(standing.bodyHoles).toEqual(lying.bodyHoles)
      expect(bodyHeightMm({ ...base, standing: true }, standing.fp)).toBe(standing.fp.body.heightMm)
    }
  })

  it('the bench sheet calls them upright, and an axial lying or standing', () => {
    const m = benchModel(mk({
      board: { cols: 30, rows: 30 },
      parts: [
        { ref: 'C1', footprint: 'cap-elec-8x12', at: 'E5', to: 'E7', rotation: 0, standing: true, pins: {} },
        { ref: 'D1', footprint: 'led-3mm', at: 'J5', to: 'J6', rotation: 0, pins: {} },
        { ref: 'R1', footprint: 'axial', at: 'M5', to: 'M9', rotation: 0, pins: {} },
        { ref: 'R2', footprint: 'axial', at: 'P5', to: 'P6', rotation: 0, standing: true, pins: {} }
      ]
    }))
    const mounting = (ref: string) => JSON.stringify(m).match(new RegExp(`"ref":"${ref}"[^}]*?"mounting":"(\\w+)"`))?.[1]
    expect([mounting('C1'), mounting('D1'), mounting('R1'), mounting('R2')]).toEqual(['upright', 'upright', 'lying', 'standing'])
  })
})

describe('tact switches and trimmers', () => {
  it('the switches come in five heights on the 3 x 2 hole pattern', () => {
    for (const h of [4.3, 5, 7, 9.5, 13]) {
      const fp = FOOTPRINTS[`button-6x6-h${h}`]!
      expect(fp.body.heightMm).toBe(h)
      expect(fp.pins.map(x => [x.name, x.dx, x.dy])).toEqual([['1', 0, 0], ['2', 3, 0], ['3', 0, 2], ['4', 3, 2]])
    }
    expect(FOOTPRINTS['button-6x6-h6']).toBeUndefined()
  })

  it('a switch body is 6 x 6 centred on its pins', () => {
    const r = placePart({ ref: 'S1', footprint: 'button-6x6-h5', at: 'E5', rotation: 90, pins: {} }).bodyRectMm
    expect([r.w, r.h]).toEqual([6, 6].map(v => expect.closeTo(v, 6)))
  })

  it('trimmers have pins 1, 2 (wiper) and 3 in a row', () => {
    for (const id of ['trimmer-3296w', 'trimmer-3362p'])
      expect(FOOTPRINTS[id]!.pins.map(x => x.name)).toEqual(['1', '2', '3'])
    expect(FOOTPRINTS['trimmer-3296w']!.body.heightMm).toBe(10)
    expect(FOOTPRINTS['trimmer-3362p']!.body.heightMm).toBe(4.88)
  })

  it('the 3296W screw sits at the pin-1 end', () => {
    const s = scene([{ ref: 'RV1', footprint: 'trimmer-3296w', at: 'E5', rotation: 0, pins: {} }])
    const screw = bodyOf(s.prims, 'RV1').find(p => p.kind === 'lathe')!
    if (screw.kind !== 'lathe') throw new Error('no screw')
    expect(dist(screw.axis, mm('E5'))).toBeLessThan(dist(screw.axis, mm('E7')))
  })
})

describe('SRD relay', () => {
  it('snaps each KiCad pad to a hole at most 1.5 mm away, and says it needs bending', () => {
    const fp = FOOTPRINTS['relay-srd']!
    let worst = 0
    for (const pin of fp.pins) {
      const pad = RELAY_SRD_PADS_MM[pin.name]!
      const off = Math.hypot(pin.dx * FOOTPRINT_PITCH_MM - pad.x, pin.dy * FOOTPRINT_PITCH_MM - pad.y)
      expect(off, pin.name).toBeLessThanOrEqual(1.5)
      worst = Math.max(worst, off)
    }
    expect(worst).toBeGreaterThan(0.6)
    expect(fp.name).toContain('bend to fit')
    expect(fp.pins.map(x => x.name).sort()).toEqual(['1', '2', '3', '4', '5'])
  })

  it('its body covers every pin, rotated too', () => {
    for (const rotation of [0, 90] as const) {
      const pp = placePart({ ref: 'K1', footprint: 'relay-srd', at: 'J10', rotation, pins: {} })
      const r = pp.bodyRectMm
      for (const { hole } of pp.pins) {
        const m = holeMm(hole, FOOTPRINT_PITCH_MM)
        expect(m.x > r.x && m.x < r.x + r.w && m.y > r.y && m.y < r.y + r.h).toBe(true)
      }
    }
  })
})

describe('bench sheet orientation', () => {
  it('names the LED cathode and the electrolytic minus by hole', () => {
    const m = benchModel(mk({
      board: { cols: 30, rows: 30 },
      parts: [
        { ref: 'D1', footprint: 'led-5mm', at: 'E5', to: 'F5', rotation: 0, pins: {} },
        { ref: 'C1', footprint: 'cap-elec-6.3x11', at: 'H8', to: 'H9', rotation: 0, pins: {} },
        { ref: 'Q1', footprint: 'to92', at: 'L12', rotation: 0, pins: {} }
      ]
    }))
    const text = JSON.stringify(m)
    expect(text).toContain('cathode (flat side) at F5')
    expect(text).toContain('minus (stripe) at H9')
    expect(text).toMatch(/flat side toward row/)
  })
})
