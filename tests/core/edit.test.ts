import { describe, it, expect } from 'vitest'
import { pencilClick, eraseSegment, toggleJoint, nextTrailId, type Drawing, type EditResult } from '~core/edit'
import type { BoardFile } from '~core/schema'
import { parseHole } from '~core/holes'
import { mk, axial, trail } from './helpers'

const H = parseHole
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) }
  return o
}
function clicks(board: BoardFile, side: 'top' | 'bottom', names: string[]) {
  let b = board
  let d: Drawing | null = null
  for (const n of names) {
    const r: EditResult = pencilClick(b, side, H(n), d)
    if (!r.ok) throw new Error(r.reason)
    b = r.board; d = r.drawing
  }
  return { board: b, drawing: d }
}

describe('pencilClick', () => {
  it('pencil draws an L', () => {
    const { board, drawing } = clicks(mk({ board: { rows: 12 } }), 'bottom', ['G2', 'G5', 'K5', 'K5'])
    expect(drawing).toBeNull()
    expect(board.trails).toHaveLength(1)
    expect(board.trails[0]!.points).toEqual(['G2', 'G5', 'K5'])
  })

  it('pencil rejects diagonal / blocked / under-body / top-on-one-sided', () => {
    const b = mk({
      board: { type: 'two-sided', blocked: [{ holes: ['B2'], reason: 'screw' }] },
      parts: [{ ref: 'KA', footprint: 'relay-g5v2', at: 'D3', rotation: 0, pins: {} }]
    })
    const first = clicks(b, 'bottom', ['G2'])
    const diag = pencilClick(first.board, 'bottom', H('H4'), first.drawing)
    expect(diag).toEqual({ ok: false, reason: 'Trails run along a row or a column: click a hole in the same row or column.' })
    const blocked = pencilClick(b, 'bottom', H('B2'), null)
    expect(blocked).toEqual({ ok: false, reason: 'Hole B2 is blocked: screw' })
    const body = pencilClick(b, 'top', H('E5'), null)
    expect(body).toEqual({ ok: false, reason: 'Hole E5 is under KA' })
    const one = pencilClick(mk(), 'top', H('A1'), null)
    expect(one).toEqual({ ok: false, reason: 'This board has no pads on the top side.' })
  })

  it('pencil ends on an existing trace with a joint', () => {
    const b = mk({ trails: [trail('T1', ['C5', 'F5'])] })
    const r = clicks(b, 'bottom', ['C2', 'C5'])
    expect(r.drawing).toBeNull()
    const t = r.board.trails.find(t => t.id !== 'T1')!
    expect(t.points).toEqual(['C2', 'C5'])
    expect(t.joints).toEqual(['C5'])
  })

  it('pencil joins a wire end on the opposite side', () => {
    const b = mk({
      board: { type: 'two-sided' },
      wires: [{ id: 'W1', kind: 'laid', side: 'top', points: ['C5', 'F5'], bareSegments: [], joints: [] }]
    })
    const r = clicks(b, 'bottom', ['C2', 'C5'])
    expect(r.drawing).toBeNull()
    expect(r.board.trails[0]!.joints).toEqual(['C5'])
    const s = clicks(b, 'bottom', ['C5'])
    expect(s.board.trails[0]!.joints).toEqual(['C5'])
    expect(s.drawing).not.toBeNull()
  })

  it('pencil adds a joint on a lead', () => {
    const b = mk({ parts: [axial('R1', 'C5', 'C8', 'N')] })
    const r = clicks(b, 'bottom', ['C2', 'C5', 'F5'])
    expect(r.board.trails[0]!.joints).toEqual(['C5'])
    expect(r.drawing).not.toBeNull()
  })
})

describe('eraseSegment', () => {
  it('erase splits and keeps joints', () => {
    const b = mk({ trails: [trail('T1', ['A1', 'A9'], 'bottom', ['A1', 'A5', 'A9'])] })
    const r = eraseSegment(b, 'bottom', H('A4'), H('A5'))
    if (!r.ok) throw new Error(r.reason)
    expect(r.board.trails.map(t => [t.points, t.joints])).toEqual([
      [['A1', 'A4'], ['A1']],
      [['A5', 'A9'], ['A5', 'A9']]
    ])
    expect(new Set(r.board.trails.map(t => t.id)).size).toBe(2)
  })

  it('erase last segment removes the trail', () => {
    const b = mk({ trails: [trail('T1', ['A1', 'A2'])] })
    const r = eraseSegment(b, 'bottom', H('A1'), H('A2'))
    expect(r.ok && r.board.trails).toEqual([])
  })

  it('erase never touches wires', () => {
    const b = mk({ wires: [{ id: 'W1', kind: 'laid', side: 'bottom', points: ['A1', 'A9'], bareSegments: [], joints: [] }] })
    const r = eraseSegment(b, 'bottom', H('A4'), H('A5'))
    expect(r).toEqual({ ok: false, reason: 'No trail segment between A4 and A5 on this side.' })
  })
})

describe('toggleJoint', () => {
  it('toggleJoint adds then removes', () => {
    const b = mk({ trails: [trail('T1', ['A1', 'A9'])] })
    const r1 = toggleJoint(b, 'bottom', H('A5'))
    if (!r1.ok) throw new Error(r1.reason)
    expect(r1.board.trails[0]!.joints).toEqual(['A5'])
    const r2 = toggleJoint(r1.board, 'bottom', H('A5'))
    if (!r2.ok) throw new Error(r2.reason)
    expect(r2.board.trails[0]!.joints).toEqual([])
    expect(toggleJoint(b, 'bottom', H('B5'))).toEqual({ ok: false, reason: 'No trail on this side at B5.' })
  })
})

describe('nextTrailId', () => {
  it('first unused', () => {
    expect(nextTrailId(mk({ trails: [trail('T1', ['A1', 'A2']), trail('T3', ['B1', 'B2'])] }))).toBe('T2')
  })
})

describe('purity', () => {
  it("edit functions don't mutate input", () => {
    const b = deepFreeze(mk({
      parts: [axial('R1', 'C5', 'C8', 'N')],
      trails: [trail('T1', ['A1', 'A9'], 'bottom', ['A5'])]
    }))
    pencilClick(b, 'bottom', H('C2'), null)
    const s = clicks(b, 'bottom', ['C2', 'C5'])
    expect(s.board.revision).toBe(b.revision)
    eraseSegment(b, 'bottom', H('A4'), H('A5'))
    toggleJoint(b, 'bottom', H('A3'))
    toggleJoint(b, 'bottom', H('A5'))
    expect(b.trails[0]!.joints).toEqual(['A5'])
  })
})
