// Which pointers move the Move tool's target by hovering.
import { describe, expect, it } from 'vitest'
import { hoverHole, hoverMovesTarget } from '../../app/utils/movePointer'

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
  it('outside the Move tool a diagonal gap has no hole', () => {
    expect(hoverHole(2.3, 3.3, 10, 10, false)).toEqual({ col: 2, row: 3 })
    expect(hoverHole(2.4, 3.6, 10, 10, false)).toBeNull() // 0.4² + 0.4² > 0.5²
  })

  it('in the Move tool the gap snaps to the hole a click rounds to', () => {
    // onMoveClick rounds the click: (2.4, 3.6) -> column 2, row 4.
    expect(hoverHole(2.4, 3.6, 10, 10, true)).toEqual({ col: 2, row: 4 })
  })

  it('off the board there is no hole, in the Move tool too', () => {
    expect(hoverHole(0.4, 3, 10, 10, true)).toBeNull() // rounds to column 0
    expect(hoverHole(3, 10.6, 10, 10, true)).toBeNull() // rounds to row 11
    expect(hoverHole(10.6, 3, 10, 10, false)).toBeNull() // rounds to column 11
  })
})
