import { describe, expect, it } from 'vitest'
import { benchModel } from '~core/bench/sheet'
import { runCheck } from '~core/check'
import { edgeLabels } from '~core/edgeLabels'
import { holeLabel, printedName, stripLabel } from '~core/holeLabel'
import { parseHole } from '~core/holes'
import { breadboard400, mk } from './helpers'

const H = parseHole
const bb = mk({ board: breadboard400() }).board
const plain = mk().board

describe('holeLabel and printedName', () => {
  it('give the printed name with the grid name for messages, alone for the drawing', () => {
    expect(holeLabel(bb, H('O12'))).toBe('a12 (O12)')
    expect(printedName(bb, H('O12'))).toBe('a12')
    expect(holeLabel(bb, H('D3'))).toBe('j3 (D3)')
  })
  it('keep the grid name on a rail, as both pairs print + and -', () => {
    expect(holeLabel(bb, H('A3'))).toBe('+3 (A3)')
    expect(printedName(bb, H('A3'))).toBe('+3 (A3)')
    expect(printedName(bb, H('Q3'))).toBe('-3 (Q3)')
  })
  it('give the grid name on a row with no label, and on a board without labels', () => {
    expect(holeLabel(bb, H('I3'))).toBe('I3')
    expect(holeLabel(plain, H('D12'))).toBe('D12')
    expect(printedName(plain, H('D12'))).toBe('D12')
  })
  it('name strips', () => {
    expect(stripLabel(bb, 'K7-O7')).toBe('strip e7–a7 (K7–O7)')
    expect(stripLabel(plain, 'B1-B10')).toBe('strip B1–B10')
  })
})

describe('edgeLabels', () => {
  it('prints a breadboard\'s row names and numbers its columns 1, 5, 10, …', () => {
    const l = edgeLabels(bb)
    expect(l.rows.map(r => r.text)).toEqual(['+', '-', 'j', 'i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a', '-', '+'])
    expect(l.rows.find(r => r.text === 'a')!.row).toBe(15)
    expect(l.cols.map(c => c.text)).toEqual(['1', '5', '10', '15', '20', '25', '30'])
  })
  it('leaves a plain board as before', () => {
    const l = edgeLabels(plain)
    expect(l.cols).toHaveLength(10)
    expect(l.rows.map(r => r.text)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
  })
})

describe('findings and the bench sheet on a breadboard', () => {
  const header = (ref: string, at: string) => ({ ref, footprint: 'header-1x1', at, rotation: 0 as const, pins: { 1: 'X' } })
  const b = mk({ board: breadboard400(), parts: [header('J1', 'O12'), header('J2', 'O12')] })
  it('name holes a12 (O12) in messages, and keep grid names in the holes list', () => {
    const f = runCheck(b).findings.find(x => x.rule === 'twoInOneHole')!
    expect(f.message).toBe('Two in one hole: J1.1 and J2.1 share a12 (O12)')
    expect(f.holes).toEqual(['O12'])
  })
  it('print a12 in the placement table', () => {
    expect(benchModel(b).placement.map(p => p.holes)).toEqual(['1:a12', '1:a12'])
  })
})
