import { describe, expect, it } from 'vitest'
import { ghostTransform, moveCopy, moveSides } from '../../app/utils/moveCopy'
import type { Held } from '../../app/composables/useTools'
import { mapHole, movePart, type Placement, type Turns } from '~core/move'
import { parseHole, type Hole } from '~core/holes'
import { axial, mk } from '../core/helpers'

const H = parseHole

/** Applies an SVG `matrix(a b c d e f)` to a point. */
function apply(m: string, p: { x: number, y: number }) {
  const [a, b, c, d, e, f] = m.slice(7, -1).split(' ').map(Number) as [number, number, number, number, number, number]
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }
}

const plain = { pt: (h: Hole) => ({ x: h.col * 2.54, y: h.row * 2.54 }) }
const mirrored = { pt: (h: Hole) => ({ x: -h.col * 2.54 + 50, y: h.row * 2.54 }) }

describe('ghostTransform', () => {
  for (const [name, geo] of [['plain', plain], ['mirrored', mirrored]] as const) {
    it(`draws each hole where the placement takes it (${name})`, () => {
      for (const turns of [0, 1, 2, 3] as Turns[]) {
        const p: Placement = { from: H('C3'), to: H('A1'), turns }
        const m = ghostTransform(geo, p)
        // The grabbed hole, a far one, and one that lands left of column 1 / above row A.
        for (const h of [H('C3'), H('F9'), H('C6')]) {
          const got = apply(m, geo.pt(h))
          const want = geo.pt(mapHole(h, p))
          expect(got.x).toBeCloseTo(want.x, 6)
          expect(got.y).toBeCloseTo(want.y, 6)
        }
      }
    })
  }
})

describe('moveCopy', () => {
  const b = mk({ parts: [axial('R1', 'B2', 'B5', 'N1'), axial('R2', 'E2', 'E5', 'N2')] })

  it('nothing held: no copy', () => {
    expect(moveCopy(null)).toBeNull()
  })

  it('a refused move: only the held part, tinted red, with the ghost passed through', () => {
    const p: Placement = { from: H('B2'), to: H('B1'), turns: 2 }
    const r = movePart(b, 'R1', p)
    const c = moveCopy({ board: r.board, key: 'part:R1', ok: r.reason === null, ghost: r.ghost })!
    expect(c.board.parts.map(x => x.ref)).toEqual(['R1'])
    expect(c.placed).toHaveLength(1)
    expect(c.tint).toBe('#e5484d')
    expect(c.ghost).toEqual(p)
  })

  it('an allowed move: not tinted, no ghost', () => {
    const r = movePart(b, 'R1', { from: H('B2'), to: H('G3'), turns: 0 })
    const c = moveCopy({ board: r.board, key: 'part:R1', ok: r.reason === null, ghost: r.ghost })!
    expect(c.tint).toBeNull()
    expect(c.ghost).toBeNull()
    expect(c.board.wires).toEqual([])
    expect(c.board.trails).toEqual([])
  })
})

describe('moveSides', () => {
  const b = mk({
    parts: [axial('R1', 'B2', 'B5', 'N1'), axial('R2', 'H2', 'H5', 'N2')],
    legFolds: [{ lead: 'R1.a', to: 'C2' }, { lead: 'R2.a', to: 'I2' }]
  })
  const held = (pick: Held['pick'], side: Held['side'] = 'top'): Held =>
    ({ pick, side, target: pick.at, turns: 0, bend: 'row-first', snapshot: '' })

  it('nothing held: no copy on either side', () => {
    expect(moveSides(null, null)).toEqual({ top: null, bottom: null })
  })

  it('a part with a leg fold: its copy on top, its folds\' copy on the bottom', () => {
    const r = movePart(b, 'R1', { from: H('B2'), to: H('E3'), turns: 0 })
    const s = moveSides(held({ kind: 'part', ref: 'R1', at: H('B2') }), r)
    expect(s.top).toMatchObject({ key: 'part:R1', ok: true })
    expect(s.top!.folds).toBeFalsy()
    expect(s.bottom).toMatchObject({ key: 'part:R1', ok: true, folds: true })
    expect(moveCopy(s.bottom)!.board.legFolds).toEqual([{ lead: 'R1.a', to: 'F3' }])
  })

  it('a part without folds: nothing on the bottom', () => {
    const r = movePart(b, 'R2', { from: H('H2'), to: H('H3'), turns: 0 })
    expect(moveSides(held({ kind: 'part', ref: 'R2', at: H('H2') }), { ...r, board: { ...r.board, legFolds: [] } }).bottom).toBeNull()
  })

  it('a wire: only its own side', () => {
    const w = mk({ wires: [{ id: 'W1', kind: 'laid', side: 'bottom', points: ['B2', 'B5'], joints: [], bareSegments: [] }] })
    const s = moveSides(held({ kind: 'wire', id: 'W1', at: H('B2') }, 'bottom'), { board: w, reason: null })
    expect(s.top).toBeNull()
    expect(s.bottom).toMatchObject({ key: 'wire:W1' })
    expect(s.bottom!.folds).toBeFalsy()
  })

  it('the folds\' copy holds only the part and its folds: no trails, bridges or wires', () => {
    const c = moveCopy({ board: b, key: 'part:R1', ok: false, folds: true })!
    expect(c.folds).toBe(true)
    expect(c.board.legFolds).toEqual([{ lead: 'R1.a', to: 'C2' }])
    expect(c.board.solderBridges).toEqual([])
    expect(c.board.trails).toEqual([])
    expect(c.board.wires).toEqual([])
    expect(c.tint).toBe('#e5484d')
  })
})
