import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { benchModel } from '~core/bench/sheet'
import { parseBoard, type Part } from '~core/schema'
import { axial, mk, trail } from './helpers'

const part = (over: Partial<Part> & Pick<Part, 'ref' | 'footprint' | 'at'>): Part =>
  ({ rotation: 0, pins: {}, ...over })

describe('benchModel placement', () => {
  it('orders by height, standing parts by standing height, ties by ref', () => {
    const b = mk({
      board: { cols: 30, rows: 20 },
      parts: [
        part({ ref: 'Q1', footprint: 'to220-gds', at: 'A1', pins: { G: 'g', D: 'd', S: 's' } }),
        { ...axial('R10', 'F1', 'F4', 'a', 'b') },
        { ...axial('R2', 'H1', 'H4', 'a', 'b') },
        { ...axial('D1', 'J1', 'J4', 'a', 'b'), standing: true },
        part({ ref: 'U1', footprint: 'dip8', at: 'A10' })
      ]
    })
    const rows = benchModel(b).placement
    expect(rows.map(r => r.ref)).toEqual(['R2', 'R10', 'U1', 'D1', 'Q1'])
    expect(rows.map(r => r.step)).toEqual([1, 2, 3, 4, 5])
    expect(rows.find(r => r.ref === 'D1')).toMatchObject({ heightMm: 7, mounting: 'standing' })
    expect(rows.find(r => r.ref === 'R2')).toMatchObject({ heightMm: 2.5, mounting: 'lying', holes: 'a:H1 b:H4' })
    expect(rows.find(r => r.ref === 'U1')).toMatchObject({ mounting: 'upright', orientation: 'pin 1 at A10' })
    expect(rows.find(r => r.ref === 'U1')!.holes).toMatch(/^1:A10 2:B10 /)
  })

  it('stripe text for an axial, either way for an unmarked part', () => {
    const b = mk({ parts: [axial('D1', 'B2', 'B5', 'a', 'b'), part({ ref: 'C1', footprint: 'cap-disc', at: 'D2', value: '100n' })] })
    const rows = benchModel(b).placement
    expect(rows.find(r => r.ref === 'D1')!.orientation).toBe('stripe (cathode) at B5')
    expect(rows.find(r => r.ref === 'C1')).toMatchObject({ orientation: 'either way', value: '100n' })
  })

  it('tab text for a to220 at rotation 0 and 90', () => {
    const q = (rotation: 0 | 90 | 180 | 270) =>
      mk({ parts: [part({ ref: 'Q1', footprint: 'to220-gds', at: 'C3', rotation })] })
    expect(benchModel(q(0)).placement[0]!.orientation).toBe('metal tab toward column 4')
    // rotated 90 degrees the pins run along row C and the tab points down.
    expect(benchModel(q(90)).placement[0]!.orientation).toBe('metal tab toward row D')
    expect(benchModel(q(180)).placement[0]!.orientation).toBe('metal tab toward column 2')
    expect(benchModel(q(270)).placement[0]!.orientation).toBe('metal tab toward row B')
  })
})

describe('benchModel leg-folds', () => {
  it('writes one row per fold with the lead hole as from', () => {
    const b = mk({ board: { cols: 10, rows: 14 }, parts: [axial('D4', 'L1', 'L3', 'a', 'b')], legFolds: [{ lead: 'D4.b', to: 'L4' }] })
    expect(benchModel(b).legFolds).toEqual([
      { lead: 'D4.b', from: 'L3', to: 'L4', note: 'fold D4.b (L3) flat toward L4, solder both' }
    ])
  })
})

describe('benchModel meter lists', () => {
  const three = mk({
    parts: [
      axial('R1', 'A1', 'A4', 'n', 'x'),
      axial('R2', 'C1', 'C4', 'n', 'y'),
      axial('R3', 'E1', 'E4', 'n', 'z')
    ],
    trails: [trail('T1', ['A1', 'C1', 'E1'], 'bottom', ['C1'])]
  })

  it('chains a 3-lead net in two rows', () => {
    const rows = benchModel(three).mustBeep.filter(r => r.group === 'n')
    expect(rows).toEqual([
      { a: 'R1.a (A1)', b: 'R2.a (C1)', expect: 'beep', why: 'n continuous', group: 'n' },
      { a: 'R2.a (C1)', b: 'R3.a (E1)', expect: 'beep', why: 'n continuous', group: 'n' }
    ])
  })

  it('skips nets of a shorted group', () => {
    const b = mk({
      parts: [axial('R1', 'A1', 'A4', 'p', 'q'), axial('R2', 'C1', 'C4', 'q', 'p')],
      trails: [trail('T1', ['A1', 'C1'], 'bottom', ['A1', 'C1']), trail('T2', ['A4', 'C4'], 'bottom', ['A4', 'C4'])]
    })
    expect(benchModel(b).mustBeep).toEqual([])
  })

  const adj = mk({
    netClasses: { HV: {}, GND: {}, LOGIC: {}, SIG: {} },
    nets: { V12: { class: 'HV' }, G: { class: 'GND' }, L: { class: 'LOGIC' }, S: { class: 'SIG' }, S2: { class: 'SIG' } },
    rules: { keepAway: [], adjacency: [{ classes: ['HV', 'GND'], level: 'supply' }, { classes: ['HV', 'LOGIC'], level: 'mcu' }] },
    parts: [
      axial('R1', 'A1', 'A4', 'V12', 'S'),
      axial('R2', 'D1', 'D4', 'G', 'S'),
      axial('R3', 'A6', 'A9', 'L', 'S2'),
      axial('R4', 'B6', 'B9', 'V12', 'S2'),
      axial('R5', 'G1', 'G4', 'S', 'S2'),
      axial('R6', 'H1', 'H4', 'S2', 'S')
    ]
  })

  it('lists the class-pair row, the mcu adjacent row, not harmless ones', () => {
    const m = benchModel(adj)
    expect(m.mustNotBeep[0]).toEqual({
      a: 'R1.a (A1)', b: 'R2.a (D1)', expect: 'no beep', why: 'supply not shorted', group: 'Shorts the supply'
    })
    const mcu = m.mustNotBeep.filter(r => r.group === 'Kills the MCU')
    expect(mcu).toHaveLength(1)
    expect(mcu[0]!.why).toMatch(/^Adjacent: L at A6 next to V12 at B6/)
    expect(mcu[0]).toMatchObject({ a: 'R3.a (A6)', b: 'R4.a (B6)', expect: 'no beep' })
    // harmless: the S / S2 neighbours (G1/H1 etc.) are not listed.
    expect(m.mustNotBeep.every(r => !/harmless/.test(r.why))).toBe(true)
    expect(m.mustNotBeep).toHaveLength(2)
  })

  it('does not repeat a hole pair', () => {
    const b = mk({
      netClasses: { HV: {}, GND: {} },
      nets: { V12: { class: 'HV' }, G: { class: 'GND' } },
      rules: { keepAway: [], adjacency: [{ classes: ['HV', 'GND'], level: 'supply' }] },
      parts: [axial('R1', 'A1', 'A4', 'V12', 'V12'), axial('R2', 'B1', 'B4', 'G', 'G')]
    })
    const rows = benchModel(b).mustNotBeep
    expect(rows).toHaveLength(2) // A1/B1 once (class pair and adjacent), then A4/B4
  })

  it('collects errors and stats from the check', () => {
    const m = benchModel(three)
    expect(m.check.errors.every(f => f.severity === 'error')).toBe(true)
    expect(m.check.stats.errors).toBe(m.check.errors.length)
    expect(m).toMatchObject({ name: 'test', revision: 0, paper: 'letter' })
  })
})

describe('benchModel on channel board 2 (frozen fixture)', () => {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  const m = benchModel(res.board)
  it('has the expected counts', () => {
    expect(m.placement).toHaveLength(30)
    expect(m.cards).toHaveLength(44)
    expect(m.cards.filter(c => c.kind === 'trail')).toHaveLength(35)
    expect(m.legFolds).toHaveLength(12)
    expect(m.check.errors).toHaveLength(4)
  })
})
