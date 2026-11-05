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

describe('body geometry', () => {
  const close = (r: { x: number; y: number; w: number; h: number }, e: number[]) => {
    expect(r.x).toBeCloseTo(e[0]!, 6)
    expect(r.y).toBeCloseTo(e[1]!, 6)
    expect(r.w).toBeCloseTo(e[2]!, 6)
    expect(r.h).toBeCloseTo(e[3]!, 6)
  }
  const bh = (p: Part) => placePart(p).bodyHoles.map(holeName).sort()

  it('relay at rotation 90 swaps the box to 20.5 x 10.1', () => {
    const r = placePart(part({ footprint: 'relay-g5v2', at: 'D10', rotation: 90 })).bodyRectMm
    close(r, [22.86 - 19.14, 7.62 - 1.24, 20.5, 10.1])
  })

  it('vertical axial body is 2.5 x 6.3 centred on the lead midpoint', () => {
    const r = placePart(part({ footprint: 'axial', at: 'C2', to: 'F2' })).bodyRectMm
    close(r, [2.54 - 1.25, 8.89 - 3.15, 2.5, 6.3])
  })

  it('horizontal axial body is 6.3 x 2.5', () => {
    const r = placePart(part({ footprint: 'axial', at: 'C2', to: 'C5' })).bodyRectMm
    close(r, [2.54 + 3.81 - 3.15, 5.08 - 1.25, 6.3, 2.5])
  })

  it('dip8 bodyHoles at rotation 0', () => {
    expect(bh(part({ footprint: 'dip8', at: 'D5' }))).toEqual(
      ['D6', 'D7', 'E6', 'E7', 'F6', 'F7', 'G6', 'G7'])
  })

  it('dip8 bodyHoles at rotation 270', () => {
    expect(bh(part({ footprint: 'dip8', at: 'W8', rotation: 270 }))).toEqual(
      ['U10', 'U11', 'U8', 'U9', 'V10', 'V11', 'V8', 'V9'])
  })

  it('flipped dip8 body extends to the left of pin 1', () => {
    const r = placePart(part({ footprint: 'dip8', at: 'D10', flip: true })).bodyRectMm
    close(r, [22.86 - 6.985, 7.62 - 1.09, 6.35, 9.8])
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
