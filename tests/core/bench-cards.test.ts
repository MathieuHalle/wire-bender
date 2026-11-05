import { describe, expect, it } from 'vitest'
import { wireCards } from '~core/bench/cards'
import { mk, trail } from './helpers'

const P = 2.54

const laid = (id: string, points: string[], bareSegments: number[] = [], extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'laid' as const, side: 'bottom' as const, points, bareSegments, joints: [], ...extra })
const flying = (id: string, points: string[]) =>
  ({ id, kind: 'flying' as const, side: 'bottom' as const, points, bareSegments: [], joints: [] })

const big = { cols: 40, rows: 40 }
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe('wireCards', () => {
  it('spec example: 200 mm cut', () => {
    // 30 + 12 + 30 = 72 holes of straight runs, 2 bends.
    const b = mk({ board: big, wires: [laid('W1', ['A1', 'A31', 'M31', 'M1'])] })
    const [c] = wireCards(b)
    expect(c!.kind).toBe('laid')
    expect(c!.breakdown.pathMm).toBeCloseTo(72 * P, 9)
    expect(c!.breakdown.pathMm).toBeCloseTo(182.88, 9)
    expect(c!.breakdown).toMatchObject({ bendsMm: 2, leadsMm: 10, spareMm: 5, slackMm: 0 })
    expect(c!.bends).toHaveLength(2)
    expect(c!.cutMm).toBe(200)
    expect(sum(c!.stretches.map(s => s.lengthMm))).toBeCloseTo(200, 9)
    // Both bends sit in the insulated stretch: 182.88 + 2 x 1 mm.
    expect(c!.stretches.map(s => s.bare)).toEqual([true, false, true])
    expect(c!.stretches[0]!.lengthMm).toBe(5)
    expect(c!.stretches[1]!.lengthMm).toBeCloseTo(184.88, 9)
    expect(c!.stretches[2]!.lengthMm).toBeCloseTo(10.12, 9)
    expect(c!.strip[0]).toEqual({ fromStartMm: 5, toBare: false })
    expect(c!.strip[1]!.fromStartMm).toBeCloseTo(189.88, 9)
    expect(c!.start).toBe('A1')
    expect(c!.end).toBe('M1')
  })

  it('mixed wire strip marks', () => {
    // segment 0: A1 -> A38, 37 holes insulated; segment 1: A38 -> AN38, 39 holes bare.
    const ins = 37 * P
    const bare = 39 * P
    const b = mk({ board: big, wires: [laid('W1', ['A1', 'A38', 'AN38'], [1])] })
    const [c] = wireCards(b)
    expect(c!.segments).toHaveLength(2)
    expect(c!.segments[0]).toMatchObject({ from: 'A1', to: 'A38', bare: false })
    expect(c!.segments[0]!.lengthMm).toBeCloseTo(ins, 9)
    expect(c!.segments[1]).toMatchObject({ from: 'A38', to: 'AN38', bare: true })
    expect(c!.segments[1]!.lengthMm).toBeCloseTo(bare, 9)
    // 93.98 + 99.06 + 1 bend + 10 leads + 5 spare = 209.04 -> 210
    expect(c!.cutMm).toBe(210)
    expect(c!.strip).toHaveLength(2)
    expect(c!.strip[0]).toEqual({ fromStartMm: 5, toBare: false })
    expect(c!.strip[1]!.toBare).toBe(true)
    // The bend at A38 is on the boundary: its allowance goes to the stretch before it.
    expect(c!.strip[1]!.fromStartMm).toBeCloseTo(5 + ins + 1, 9)
    expect(c!.strip[1]!.fromStartMm).toBeCloseTo(99.98, 9)
    expect(c!.stretches.map(s => s.bare)).toEqual([true, false, true])
    expect(c!.stretches[0]!.lengthMm).toBe(5)
    expect(c!.stretches[1]!.lengthMm).toBeCloseTo(ins + 1, 9)
    expect(c!.stretches[2]!.lengthMm).toBeCloseTo(210 - 5 - ins - 1, 9)
  })

  it('insulated bends before a bare segment move the strip mark by their allowance', () => {
    // A1 -> A10 (9 holes) -> J10 (9 holes) insulated, J10 -> J20 (10 holes) bare.
    const ins = 18 * P
    const b = mk({ board: big, wires: [laid('W1', ['A1', 'A10', 'J10', 'J20'], [2])] })
    const [c] = wireCards(b)
    expect(c!.bends.map(x => x.at)).toEqual(['A10', 'J10'])
    // 28 x 2.54 = 71.12 + 2 + 10 + 5 = 88.12 -> 90
    expect(c!.cutMm).toBe(90)
    expect(c!.strip[0]).toEqual({ fromStartMm: 5, toBare: false })
    expect(c!.strip[1]!.toBare).toBe(true)
    expect(c!.strip[1]!.fromStartMm).toBeCloseTo(5 + ins + 2, 9)
    expect(c!.stretches[1]!.lengthMm).toBeCloseTo(ins + 2, 9)
    expect(c!.stretches[2]!.lengthMm).toBeCloseTo(90 - 5 - ins - 2, 9)
  })

  it('a bend inside a bare stretch adds to that stretch, not the insulated one', () => {
    // A1 -> A5 insulated, A5 -> A9 bare, bend at A9, A9 -> E9 bare.
    const b = mk({ wires: [laid('W1', ['A1', 'A5', 'A9', 'E9'], [1, 2])] })
    const [c] = wireCards(b)
    expect(c!.bends.map(x => x.at)).toEqual(['A9'])
    expect(c!.strip[1]!.fromStartMm).toBeCloseTo(5 + 4 * P, 9)
    expect(c!.stretches[1]!.lengthMm).toBeCloseTo(4 * P, 9)
  })

  it('laid wire with no bare segments still has bare end leads', () => {
    const b = mk({ wires: [laid('W1', ['A1', 'A5'])] })
    const [c] = wireCards(b)
    // 10.16 + 10 + 5 = 25.16 -> 30
    expect(c!.cutMm).toBe(30)
    expect(c!.stretches.map(s => s.bare)).toEqual([true, false, true])
    expect(c!.strip).toEqual([
      { fromStartMm: 5, toBare: false },
      { fromStartMm: 5 + 4 * P, toBare: true }
    ])
  })

  it('trail has no strip marks and bare stretches only', () => {
    const b = mk({ trails: [trail('T1', ['A1', 'A5', 'E5'])] })
    const [c] = wireCards(b)
    expect(c!.kind).toBe('trail')
    expect(c!.segments.every(s => s.bare)).toBe(true)
    expect(c!.strip).toEqual([])
    expect(c!.stretches).toEqual([{ lengthMm: c!.cutMm, bare: true }])
    // 8 holes = 20.32 + 1 bend + 10 + 5 = 36.32 -> 40
    expect(c!.cutMm).toBe(40)
  })

  it('flying wire: straight distance + slack, no bends', () => {
    const b = mk({ wires: [flying('F1', ['A1', 'D5'])] })
    const [c] = wireCards(b)
    expect(c!.kind).toBe('flying')
    expect(c!.segments).toEqual([])
    expect(c!.bends).toEqual([])
    expect(c!.breakdown.pathMm).toBeCloseTo(12.7, 9)
    expect(c!.breakdown).toMatchObject({ bendsMm: 0, leadsMm: 10, spareMm: 5, slackMm: 10 })
    expect(c!.cutMm).toBe(40)
    expect(c!.stretches.map(s => s.bare)).toEqual([true, false, true])
    expect(sum(c!.stretches.map(s => s.lengthMm))).toBeCloseTo(40, 9)
  })

  it('bend direction on the top', () => {
    const b = mk({ board: { type: 'two-sided' }, trails: [trail('T1', ['A1', 'A5', 'E5'], 'top')] })
    const [c] = wireCards(b)
    expect(c!.bends).toEqual([{ at: 'A5', index: 1, angleDeg: 90, dir: 'right' }])
  })

  it('bend direction on the bottom is mirrored', () => {
    const b = mk({ trails: [trail('T1', ['A1', 'A5', 'E5'], 'bottom')] })
    const [c] = wireCards(b)
    expect(c!.bends).toEqual([{ at: 'A5', index: 1, angleDeg: 90, dir: 'left' }])
  })

  it('left turn on the top, and a reversal is a 180 back bend', () => {
    const b = mk({
      board: { type: 'two-sided' },
      trails: [trail('T1', ['E1', 'E5', 'A5', 'C5'], 'top')]
    })
    const [c] = wireCards(b)
    expect(c!.bends).toEqual([
      { at: 'E5', index: 1, angleDeg: 90, dir: 'left' },
      { at: 'A5', index: 2, angleDeg: 180, dir: 'back' }
    ])
    expect(c!.breakdown.bendsMm).toBe(2)
  })

  it('collinear points merge', () => {
    const b = mk({ trails: [trail('T1', ['A1', 'A3', 'A6'])] })
    const [c] = wireCards(b)
    expect(c!.segments).toHaveLength(1)
    expect(c!.segments[0]).toMatchObject({ from: 'A1', to: 'A6', bare: true })
    expect(c!.segments[0]!.lengthMm).toBeCloseTo(5 * P, 9)
    expect(c!.bends).toEqual([])
  })

  it('collinear points with a bare/insulated change stay two segments', () => {
    const b = mk({ wires: [laid('W1', ['A1', 'A3', 'A6'], [1])] })
    const [c] = wireCards(b)
    expect(c!.segments.map(s => s.bare)).toEqual([false, true])
    expect(c!.bends).toEqual([])
  })

  it('half-drawn trail skipped with a note', () => {
    const b = mk({ trails: [trail('T1', ['A1'])] })
    const [c] = wireCards(b)
    expect(c!.note).toBe('half-drawn trail (1 point), skipped')
    expect(c!.segments).toEqual([])
    expect(c!.bends).toEqual([])
    expect(c!.cutMm).toBe(0)
    expect(c!.stretches).toEqual([])
    expect(c!.strip).toEqual([])
  })

  it('cards are ordered T2 before T10, trails before wires', () => {
    const b = mk({
      trails: [trail('T10', ['A1', 'A3']), trail('T2', ['C1', 'C3'])],
      wires: [laid('W10', ['E1', 'E3']), laid('W2', ['G1', 'G3'])]
    })
    expect(wireCards(b).map(c => c.id)).toEqual(['T2', 'T10', 'W2', 'W10'])
  })

  it('net, class and colour come from the trail group or the wire colour', () => {
    const b = mk({
      netClasses: { power: { color: '#f00' } },
      nets: { VCC: { class: 'power' }, GND: {} },
      parts: [
        { ref: 'R1', footprint: 'axial', at: 'A1', to: 'A4', rotation: 0, pins: { a: 'VCC', b: 'GND' } },
        { ref: 'R2', footprint: 'axial', at: 'J1', to: 'J4', rotation: 0, pins: { a: 'VCC', b: 'GND' } }
      ],
      trails: [trail('T1', ['A1', 'E1']), trail('T2', ['G6', 'G8'])],
      wires: [laid('W1', ['A4', 'J4'], [], { color: 'black' })]
    })
    const cards = wireCards(b)
    const t1 = cards.find(c => c.id === 'T1')!
    expect(t1).toMatchObject({ net: 'VCC', netClass: 'power', color: '#f00' })
    const t2 = cards.find(c => c.id === 'T2')!
    expect(t2).toMatchObject({ net: null, netClass: null, color: null })
    const w1 = cards.find(c => c.id === 'W1')!
    expect(w1).toMatchObject({ net: 'GND', netClass: null, color: 'black' })
  })
})
