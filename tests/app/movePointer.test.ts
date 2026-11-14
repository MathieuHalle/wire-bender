// Which pointers move the Move tool's target by hovering.
import { describe, expect, it } from 'vitest'
import { hoverMovesTarget } from '../../app/utils/movePointer'

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
