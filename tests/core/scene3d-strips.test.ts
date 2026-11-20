import { describe, expect, it } from 'vitest'
import { buildScene, BREADBOARD_THICKNESS_MM, COLORS } from '~core/scene3d'
import { breadboard400, mk } from './helpers'

const dip8 = { ref: 'U1', footprint: 'dip8', at: 'H5', rotation: 90 as const, pins: {} }
const jumper = { id: 'W1', kind: 'laid' as const, side: 'top' as const, points: ['K20', 'K24'], bareSegments: [], joints: [] }

describe('a breadboard in 3D', () => {
  const s = buildScene(mk({ board: breadboard400(), parts: [dip8], wires: [jumper] }))
  it('is an ivory block, its top at y = 0, with square holes and no pads', () => {
    expect(s.board.thicknessMm).toBe(BREADBOARD_THICKNESS_MM)
    expect(s.board.center[1]).toBeCloseTo(-BREADBOARD_THICKNESS_MM / 2)
    expect(s.board.look).toEqual({ color: COLORS.breadboard, print: COLORS.breadboardPrint, squareHoles: true })
    expect(s.holes).toHaveLength(400)
    expect(s.pads).toEqual({ top: [], bottom: [] })
  })
  it('has no solder', () => {
    expect(s.prims.filter(p => p.kind === 'cone')).toEqual([])
  })
  it('prints the channel and four rail lines', () => {
    const boxes = s.prims.filter(p => p.kind === 'box' && p.tag.kind === 'board')
    expect(boxes.map(b => b.color).sort()).toEqual([COLORS.channel, COLORS.railMinus, COLORS.railMinus, COLORS.railPlus, COLORS.railPlus].sort())
  })
  it('keeps its parts and jumpers', () => {
    expect(s.prims.some(p => p.tag.kind === 'part' && p.tag.id === 'U1')).toBe(true)
    expect(s.prims.some(p => p.tag.kind === 'wire' && p.tag.id === 'W1')).toBe(true)
  })
})

describe('a stripboard in 3D', () => {
  it('has one copper band per strip on the bottom', () => {
    const s = buildScene(mk({ board: { strips: [{ from: 'A1', to: 'A10' }, { from: 'B1', to: 'B10' }] } }))
    const bands = s.prims.filter(p => p.kind === 'box' && p.color === COLORS.copper)
    expect(bands).toHaveLength(2)
    expect(bands[0]!.kind === 'box' && bands[0]!.center[1]).toBeLessThan(-1.6)
    expect(s.board.look).toBeUndefined()
  })
})

describe('a cut stripboard in 3D', () => {
  it('splits the band at the cut', () => {
    const s = buildScene(mk({ board: { strips: [{ from: 'A1', to: 'A10' }] }, cuts: ['A4'] }))
    expect(s.prims.filter(p => p.kind === 'box' && p.color === COLORS.copper)).toHaveLength(2)
  })
})
