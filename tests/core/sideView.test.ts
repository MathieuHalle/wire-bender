import { describe, expect, it } from 'vitest'
import { parseHole } from '~core/holes'
import { ghostWires, parseFlip, sideMap } from '~core/sideView'
import { mk } from './helpers'

const wire = (id: string, kind: 'laid' | 'flying', side: 'top' | 'bottom', points: string[]) =>
  ({ id, kind, side, points, bareSegments: [], joints: [] })

describe('sideMap', () => {
  it('maps holes to mm, x mirrored about the last column when asked', () => {
    const b = mk({ board: { cols: 11, rows: 5, pitchMm: 2 } })
    expect(sideMap(b, 'none').pt({ col: 3, row: 2 })).toEqual({ x: 4, y: 2 })
    expect(sideMap(b, 'lr').pt({ col: 3, row: 2 })).toEqual({ x: 16, y: 2 })
    expect(sideMap(b, 'lr').span).toBe(20)
  })

  it('tb mirrors y about the board centre: A1 goes to the last row, the last row to the top', () => {
    const b = mk({ board: { cols: 11, rows: 5, pitchMm: 2 } })
    const m = sideMap(b, 'tb')
    expect(m.height).toBe(8)
    // columns stay put, rows run the other way
    expect(m.pt({ col: 1, row: 1 })).toEqual({ x: 0, y: 8 })
    expect(m.pt({ col: 1, row: 5 })).toEqual({ x: 0, y: 0 })
    expect(m.pt({ col: 3, row: 2 })).toEqual({ x: 4, y: 6 })
    expect(m.mirrored).toBe(true)
    expect(sideMap(b, 'none').mirrored).toBe(false)
  })

  it('rect mirrors with the axis: x for lr, y for tb', () => {
    const b = mk({ board: { cols: 11, rows: 5, pitchMm: 2 } })
    const r = { x: 1, y: 1, w: 3, h: 2 }
    expect(sideMap(b, 'none').rect(r)).toEqual(r)
    expect(sideMap(b, 'lr').rect(r)).toEqual({ x: 16, y: 1, w: 3, h: 2 })
    expect(sideMap(b, 'tb').rect(r)).toEqual({ x: 1, y: 5, w: 3, h: 2 })
  })

  it('its inverse (drawing mm -> fractional hole) round-trips, for every mirror', () => {
    const b = mk({ board: { cols: 11, rows: 5, pitchMm: 2.54 } })
    for (const mirror of ['none', 'lr', 'tb'] as const) {
      const m = sideMap(b, mirror)
      for (const h of [{ col: 1, row: 1 }, { col: 11, row: 5 }, { col: 4, row: 2 }]) {
        const back = m.hole(m.pt(h))
        expect(back.col, mirror).toBeCloseTo(h.col, 9)
        expect(back.row, mirror).toBeCloseTo(h.row, 9)
      }
    }
    // between holes stays fractional: half a pitch below A1's drawn spot on tb is row 0.5
    const tb = sideMap(b, 'tb')
    const a1 = tb.pt({ col: 1, row: 1 })
    expect(tb.hole({ x: a1.x, y: a1.y + 1.27 }).row).toBeCloseTo(0.5, 9)
  })
})

describe('parseFlip', () => {
  it('takes lr or tb, nothing else', () => {
    expect(parseFlip('lr')).toBe('lr')
    expect(parseFlip('tb')).toBe('tb')
    for (const v of ['LR', 'none', '', 'tb ', null, undefined, 1, ['tb']]) expect(parseFlip(v), String(v)).toBeNull()
  })
})

describe('ghostWires', () => {
  const b = mk({
    board: { cols: 10, rows: 10, type: 'two-sided' },
    wires: [
      wire('W1', 'laid', 'top', ['A1', 'A5', 'D5']),
      wire('W2', 'flying', 'top', ['B2', 'C3', 'F9']),
      wire('W3', 'laid', 'bottom', ['J1', 'J4'])
    ]
  })

  it('returns the other side\'s wires only, through that side\'s mapping', () => {
    const g = ghostWires(b, 'bottom', 'lr')
    expect(g.map(w => w.id)).toEqual(['W1', 'W2'])
    const m = sideMap(b, 'lr')
    expect(g[0]!.points).toEqual(['A1', 'A5', 'D5'].map(h => m.pt(parseHole(h))))
    expect(ghostWires(b, 'top', 'none').map(w => w.id)).toEqual(['W3'])
  })

  it('a flying wire is a straight line between its ends', () => {
    const g = ghostWires(b, 'bottom', 'none')
    const m = sideMap(b, 'none')
    expect(g[1]!.points).toEqual([m.pt(parseHole('B2')), m.pt(parseHole('F9'))])
  })

  it('follows the tb flip like the side\'s own holes', () => {
    const g = ghostWires(b, 'bottom', 'tb')
    const m = sideMap(b, 'tb')
    expect(g[0]!.points).toEqual(['A1', 'A5', 'D5'].map(h => m.pt(parseHole(h))))
    expect(g[0]!.points[0]).toEqual({ x: 0, y: 9 * 2.54 })
  })

  it('nothing on the other side: no ghosts', () => {
    expect(ghostWires(mk({ wires: [wire('W1', 'laid', 'bottom', ['A1', 'A3'])] }), 'bottom', 'lr')).toEqual([])
  })
})
