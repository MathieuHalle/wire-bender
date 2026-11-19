import { describe, expect, it } from 'vitest'
import { existingHoles, holeExists } from '~core/boardShape'
import { holeKey, holeName, parseHole, rowToLetters } from '~core/holes'
import { parseBoard } from '~core/schema'
import { stripHoles, stripIndex } from '~core/strips'
import { mk } from './helpers'

const H = parseHole
const raw = (board: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  format: 'wirebender/1', revision: 0, name: 't',
  board: { cols: 10, rows: 10, pitchMm: 2.54, type: 'one-sided', blocked: [], ...board },
  netClasses: {}, nets: {}, rules: { keepAway: [], adjacency: [] },
  parts: [], trails: [], wires: [], legFolds: [], solderBridges: [], ...rest
})
const errors = (board: Record<string, unknown>, rest: Record<string, unknown> = {}) => {
  const r = parseBoard(raw(board, rest))
  return r.ok ? [] : r.errors
}

/** An 830-hole breadboard layout: clip strips per column, four 50-hole rails in groups of 5. */
function bb830() {
  const L = rowToLetters
  const strips: { from: string, to: string }[] = []
  for (let c = 1; c <= 63; c++) strips.push({ from: `${L(4)}${c}`, to: `${L(8)}${c}` }, { from: `${L(11)}${c}`, to: `${L(15)}${c}` })
  for (const row of [1, 2, 17, 18])
    for (let g = 0; g < 10; g++) strips.push({ from: `${L(row)}${3 + g * 6}`, to: `${L(row)}${7 + g * 6}` })
  return { cols: 63, rows: 18, pitchMm: 2.54, type: 'breadboard' as const, blocked: [], shape: { kind: 'strips' as const }, strips }
}

describe('stripHoles', () => {
  it('walks a row or a column either way', () => {
    expect(stripHoles({ from: 'A1', to: 'A4' }).map(holeName)).toEqual(['A1', 'A2', 'A3', 'A4'])
    expect(stripHoles({ from: 'D3', to: 'B3' }).map(holeName)).toEqual(['D3', 'C3', 'B3'])
    expect(stripHoles({ from: 'C5', to: 'C5' }).map(holeName)).toEqual(['C5'])
  })
  it('gives nothing for a diagonal', () => {
    expect(stripHoles({ from: 'B3', to: 'D5' })).toEqual([])
  })
})

describe('the strips shape', () => {
  const b = mk({ board: { shape: { kind: 'strips' }, strips: [{ from: 'A1', to: 'A5' }, { from: 'C2', to: 'F2' }] } }).board
  it('keeps only the strip holes', () => {
    expect(holeExists(b, H('A3'))).toBe(true)
    expect(holeExists(b, H('E2'))).toBe(true)
    expect(holeExists(b, H('B1'))).toBe(false)
    expect(holeExists(b, H('A6'))).toBe(false)
    expect(existingHoles(b)).toHaveLength(9)
  })
  it('indexes each hole to its strip', () => {
    const m = stripIndex(b)
    expect(m.get(holeKey(H('A1')))).toBe(0)
    expect(m.get(holeKey(H('F2')))).toBe(1)
    expect(m.get(holeKey(H('B1')))).toBeUndefined()
    expect(stripIndex(b)).toBe(m) // cached
  })
  it('is fast on an 830 board', () => {
    const r = parseBoard(raw(bb830()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const t0 = performance.now()
    const hs = existingHoles(r.board.board)
    const ms = performance.now() - t0
    expect(hs).toHaveLength(830)
    // The 2D view asks on every render; the index is built once per strips array. Generous for CI.
    expect(ms).toBeLessThan(20)
  })
})

describe('the format', () => {
  it('reads a one-sided board with strips and no shape (a stripboard)', () => {
    expect(errors({ strips: [{ from: 'A1', to: 'A10' }, { from: 'B1', to: 'B10' }] })).toEqual([])
  })
  it('refuses a diagonal strip', () => {
    expect(errors({ strips: [{ from: 'B3', to: 'D5' }] })).toEqual(['board.strips[0]: B3 to D5 is not along one row or column'])
  })
  it('refuses a strip off the grid', () => {
    expect(errors({ strips: [{ from: 'A1', to: 'A11' }] })).toEqual(['board.strips[0].to: hole A11 is outside the 10 x 10 board'])
  })
  it('refuses overlapping strips', () => {
    expect(errors({ strips: [{ from: 'A1', to: 'A5' }, { from: 'A1', to: 'E1' }] }))
      .toEqual(['board.strips[1]: shares A1 with board.strips[0]'])
  })
  it('refuses the strips shape with no strip', () => {
    expect(errors({ shape: { kind: 'strips' } })).toEqual(['board.shape: strips names no strip'])
  })
  it('refuses a breadboard with no strips', () => {
    expect(errors({ type: 'breadboard' })).toEqual(['board.strips: a breadboard has no strips'])
  })
  it('checks rowLabels', () => {
    const labels = (rowLabels: string[]) => errors({ rows: 3, rowLabels })
    expect(labels(['+', '', 'a'])).toEqual([])
    expect(labels(['+', 'a'])).toEqual(['board.rowLabels: 2 labels for 3 rows'])
    expect(labels(['+', '', '+'])).toEqual([]) // both pairs of rails print + and -
    expect(labels(['A', '', 'b'])).toEqual(['board.rowLabels[0]: "A" looks like a grid row name'])
  })
  it('refuses solder on a breadboard', () => {
    const board = { type: 'breadboard', strips: [{ from: 'A1', to: 'A5' }, { from: 'B1', to: 'B5' }] }
    expect(errors(board, {
      trails: [{ id: 'T1', side: 'bottom', points: ['A1', 'A2'], joints: [] }],
      legFolds: [{ lead: 'R1.a', to: 'A2' }],
      solderBridges: [{ side: 'bottom', a: 'A1', b: 'B1' }],
      wires: [
        { id: 'W1', kind: 'laid', side: 'bottom', points: ['A1', 'A3'], bareSegments: [0], joints: ['A2'] },
        { id: 'W2', kind: 'laid', side: 'top', points: ['A1', 'B1'], bareSegments: [], joints: [] }
      ]
    })).toEqual([
      'trails[0]: a breadboard has no solder (trails)',
      'legFolds[0]: a breadboard has no solder (leg folds)',
      'solderBridges[0]: a breadboard has no solder (solder bridges)',
      'wires[0].side: a breadboard\'s jumpers are on the top',
      'wires[0].joints: a breadboard has no solder (joints)',
      'wires[0].bareSegments: a breadboard has no solder (bare wire)'
    ])
  })
  it('reads a board without the new fields as before', () => {
    const r = parseBoard(raw({}))
    expect(r.ok && r.board.board).toEqual({ cols: 10, rows: 10, pitchMm: 2.54, type: 'one-sided', blocked: [] })
  })
})
