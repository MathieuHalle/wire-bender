// Which pointers move the Move tool's target by hovering.
import { describe, expect, it } from 'vitest'
import { hoverHole, hoverMovesTarget, hoverSnaps } from '../../app/utils/movePointer'
import { mk } from '../core/helpers'

describe('hoverMovesTarget', () => {
  it('a mouse moves the target as it hovers', () => {
    expect(hoverMovesTarget('mouse')).toBe(true)
  })

  it('a finger or a pen does not: a tap previews first', () => {
    expect(hoverMovesTarget('touch')).toBe(false)
    expect(hoverMovesTarget('pen')).toBe(false)
  })

  it('an unknown pointer (none seen yet) does not', () => {
    expect(hoverMovesTarget(null)).toBe(false)
    expect(hoverMovesTarget('')).toBe(false)
  })
})

describe('hoverHole', () => {
  /** A plain 10 × 10 board. */
  const grid = (h: { col: number, row: number }) => h.col >= 1 && h.row >= 1 && h.col <= 10 && h.row <= 10

  it('outside the Move tool a diagonal gap has no hole', () => {
    expect(hoverHole(2.3, 3.3, grid, false)).toEqual({ col: 2, row: 3 })
    expect(hoverHole(2.4, 3.6, grid, false)).toBeNull() // 0.4² + 0.4² > 0.5²
  })

  it('in the Move tool the gap snaps to the hole a click rounds to', () => {
    // onMoveClick rounds the click: (2.4, 3.6) -> column 2, row 4.
    expect(hoverHole(2.4, 3.6, grid, true)).toEqual({ col: 2, row: 4 })
  })

  it('off the board there is no hole, in the Move tool too', () => {
    expect(hoverHole(0.4, 3, grid, true)).toBeNull() // rounds to column 0
    expect(hoverHole(3, 10.6, grid, true)).toBeNull() // rounds to row 11
    expect(hoverHole(10.6, 3, grid, false)).toBeNull() // rounds to column 11
  })

  it('a hole the board\'s shape removed is no hole, either way', () => {
    const notB4 = (h: { col: number, row: number }) => grid(h) && !(h.col === 4 && h.row === 2)
    expect(hoverHole(4.1, 2, notB4, false)).toBeNull()
    expect(hoverHole(4.4, 2.4, notB4, true)).toBeNull()
  })
})

describe('hoverSnaps', () => {
  const moving = { board: mk({}), key: 'part:R1', ok: true }

  it('snaps only in the Move tool while this side holds the item', () => {
    expect(hoverSnaps('move', moving)).toBe(true)
    // Nothing held: a click picks, so the gaps between holes have no hole.
    expect(hoverSnaps('move', null)).toBe(false)
    expect(hoverSnaps('move', undefined)).toBe(false)
    // The bottom's copy of a part's folds is not holding.
    expect(hoverSnaps('move', { ...moving, folds: true })).toBe(false)
    expect(hoverSnaps('inspect', moving)).toBe(false)
  })

  it('so a point on a diagonal gap has no hole with nothing held', () => {
    const all = () => true
    expect(hoverHole(2.5, 2.5, all, hoverSnaps('move', null))).toBeNull()
    expect(hoverHole(2.5, 2.5, all, hoverSnaps('move', moving))).toEqual({ col: 3, row: 3 })
  })
})
