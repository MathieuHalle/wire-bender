import { describe, expect, it } from 'vitest'
import { parseHole } from '~core/holes'
import { ghostWires, sideMap } from '~core/sideView'
import { mk } from './helpers'

const wire = (id: string, kind: 'laid' | 'flying', side: 'top' | 'bottom', points: string[]) =>
  ({ id, kind, side, points, bareSegments: [], joints: [] })

describe('sideMap', () => {
  it('maps holes to mm, x mirrored about the last column when asked', () => {
    const b = mk({ board: { cols: 11, rows: 5, pitchMm: 2 } })
    expect(sideMap(b, false).pt({ col: 3, row: 2 })).toEqual({ x: 4, y: 2 })
    expect(sideMap(b, true).pt({ col: 3, row: 2 })).toEqual({ x: 16, y: 2 })
    expect(sideMap(b, true).span).toBe(20)
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
    const g = ghostWires(b, 'bottom', true)
    expect(g.map(w => w.id)).toEqual(['W1', 'W2'])
    const m = sideMap(b, true)
    expect(g[0]!.points).toEqual(['A1', 'A5', 'D5'].map(h => m.pt(parseHole(h))))
    expect(ghostWires(b, 'top', false).map(w => w.id)).toEqual(['W3'])
  })

  it('a flying wire is a straight line between its ends', () => {
    const g = ghostWires(b, 'bottom', false)
    const m = sideMap(b, false)
    expect(g[1]!.points).toEqual([m.pt(parseHole('B2')), m.pt(parseHole('F9'))])
  })

  it('nothing on the other side: no ghosts', () => {
    expect(ghostWires(mk({ wires: [wire('W1', 'laid', 'bottom', ['A1', 'A3'])] }), 'bottom', true)).toEqual([])
  })
})
