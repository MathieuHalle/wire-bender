import { describe, it, expect } from 'vitest'
import { FOOTPRINTS, placePart, rotateOffset } from '~core/footprints'
import { holeName, parseHole } from '~core/holes'
import { parseBoard } from '~core/schema'
import type { Part } from '~core/schema'

const part = (over: Partial<Part>): Part => ({
  ref: 'X1', footprint: 'dip8', at: 'A1', rotation: 0, pins: {}, ...over
})
const names = (p: Part) => Object.fromEntries(placePart(p).pins.map(x => [x.name, holeName(x.hole)]))

describe('placePart', () => {
  it('relay at D3 rotation 0', () => {
    const n = names(part({ footprint: 'relay-g5v2', at: 'D3' }))
    expect(n['16']).toBe('D6')
    expect(n['9']).toBe('K6')
  })

  it('dip8 matches channel board 2 U1', () => {
    const n = names(part({ footprint: 'dip8', at: 'W8', rotation: 270 }))
    expect(n).toEqual({ 1: 'W8', 2: 'W9', 3: 'W10', 4: 'W11', 5: 'T11', 6: 'T10', 7: 'T9', 8: 'T8' })
  })

  it('terminal body covers the row below', () => {
    const bh = placePart(part({ footprint: 'terminal-2p-508', at: 'A3' })).bodyHoles.map(holeName)
    for (const h of ['B3', 'B4', 'B5', 'A4']) expect(bh).toContain(h)
    for (const h of ['A3', 'A5']) expect(bh).not.toContain(h)
  })

  it('standing axial body only around lead a', () => {
    const p = placePart(part({ footprint: 'axial', at: 'L2', to: 'L1', standing: true }))
    expect(p.bodyHoles).toEqual([])
  })

  it('twoLead uses at/to and ignores rotation', () => {
    const n = names(part({ footprint: 'axial', at: 'C2', to: 'C6', rotation: 90 }))
    expect(n).toEqual({ a: 'C2', b: 'C6' })
  })

  it('pin role: override, then footprint, then passive', () => {
    const p = placePart(part({ footprint: 'dip8', roles: { 1: 'in' } }))
    expect(p.pins[0]!.role).toBe('in')
    expect(p.pins[1]!.role).toBe('passive')
  })

  it('flip mirrors dx before rotation', () => {
    const n = names(part({ footprint: 'dip8', at: 'D10', flip: true }))
    expect(n['5']).toBe('G7')
  })

  it('rotation 180 then 0 is identity for every footprint', () => {
    for (const fp of Object.values(FOOTPRINTS)) {
      if (fp.twoLead) continue
      const base = names(part({ footprint: fp.id, at: 'AA30' }))
      const r180 = names(part({ footprint: fp.id, at: 'AA30', rotation: 180 }))
      const p1 = parseHole('AA30')
      for (const pin of fp.pins) {
        const h0 = parseHole(base[pin.name]!)
        const once = rotateOffset(h0.col - p1.col, h0.row - p1.row, 180)
        const back = rotateOffset(once.dx, once.dy, 180)
        expect([back.dx, back.dy]).toEqual([h0.col - p1.col, h0.row - p1.row])
        const h180 = parseHole(r180[pin.name]!)
        const rot = rotateOffset(h180.col - p1.col, h180.row - p1.row, 180)
        expect([rot.dx, rot.dy]).toEqual([h0.col - p1.col, h0.row - p1.row])
        let four = { dx: pin.dx, dy: pin.dy }
        for (let i = 0; i < 4; i++) four = rotateOffset(four.dx, four.dy, 90)
        expect([four.dx, four.dy]).toEqual([pin.dx, pin.dy])
      }
    }
  })
})

describe('schema footprint check', () => {
  it('rejects unknown footprint', () => {
    const r = parseBoard({
      format: 'wirebender/1', revision: 0, name: 't',
      board: { cols: 18, rows: 24, pitchMm: 2.54, type: 'one-sided', blocked: [] },
      netClasses: {}, nets: {}, rules: { keepAway: [], adjacency: [] },
      parts: [part({ footprint: 'nope' })], trails: [], wires: [], legFolds: [], solderBridges: []
    })
    expect(r).toEqual({ ok: false, errors: ['parts[0].footprint: unknown "nope"'] })
  })
})
