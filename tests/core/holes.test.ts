import { describe, it, expect } from 'vitest'
import { parseHole, holeName, holeMm, straightRun, holeKey, tryParseHole } from '~core/holes'

describe('holes', () => {
  it('parses names', () => {
    expect(parseHole('G13')).toEqual({ col: 13, row: 7 })
    expect(parseHole('AA2')).toEqual({ col: 2, row: 27 })
  })
  it('formats names', () => {
    expect(holeName({ col: 13, row: 7 })).toBe('G13')
  })
  it('round-trips an 18 x 30 board', () => {
    for (let row = 1; row <= 30; row++)
      for (let col = 1; col <= 18; col++) {
        const h = { col, row }
        expect(parseHole(holeName(h))).toEqual(h)
      }
  })
  it('rejects bad names', () => {
    expect(() => parseHole('13G')).toThrow('bad hole name: 13G')
  })
  it('straightRun goes in order, both directions', () => {
    expect(straightRun(parseHole('G2'), parseHole('G5')).map(holeName)).toEqual(['G2', 'G3', 'G4', 'G5'])
    expect(straightRun(parseHole('G5'), parseHole('G2')).map(holeName)).toEqual(['G5', 'G4', 'G3', 'G2'])
    expect(straightRun(parseHole('B3'), parseHole('D3')).map(holeName)).toEqual(['B3', 'C3', 'D3'])
  })
  it('straightRun rejects diagonals', () => {
    expect(() => straightRun(parseHole('A1'), parseHole('B2'))).toThrow('diagonal')
  })
  it('holeMm and holeKey', () => {
    expect(holeMm({ col: 2, row: 1 })).toEqual({ x: 2.54, y: 0 })
    expect(holeKey({ col: 2, row: 3 })).toBe('2,3')
  })
})

describe('tryParseHole', () => {
  it('parses a hole name and returns null for anything else', () => {
    expect(tryParseHole('G13')).toEqual({ col: 13, row: 7 })
    expect(tryParseHole('A0')).toBeNull()
    expect(tryParseHole('13')).toBeNull()
  })
})
