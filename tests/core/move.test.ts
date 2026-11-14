import { describe, it, expect } from 'vitest'
import { mapHole, movePart } from '~core/move'
import { parseBoard, type BoardFile, type Part } from '~core/schema'
import { holeName, parseHole } from '~core/holes'
import { mk, axial, trail } from './helpers'

const H = parseHole
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}
const frozen = (over: Parameters<typeof mk>[0]): BoardFile => deepFreeze(mk(over))
const dip8 = (ref: string, at: string, rotation: Part['rotation'] = 0): Part =>
  ({ ref, footprint: 'dip8', at, rotation, pins: {} })

describe('mapHole', () => {
  it('lands the grabbed hole on the target and turns about it', () => {
    expect(holeName(mapHole(H('B5'), { from: H('B2'), to: H('E3'), turns: 0 }))).toBe('E6')
    expect(holeName(mapHole(H('B5'), { from: H('B2'), to: H('E3'), turns: 1 }))).toBe('H3')
    expect(holeName(mapHole(H('B5'), { from: H('B2'), to: H('E3'), turns: 2 }))).toBe('E0')
  })
})

describe('movePart', () => {
  it('moves a part: the grabbed hole lands on the target', () => {
    const b = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')] })
    const r = movePart(b, 'R1', { from: H('B2'), to: H('E3'), turns: 0 })
    expect(r.reason).toBeNull()
    expect(r.board.parts[0]).toMatchObject({ at: 'E3', to: 'E6' })
  })

  it('rotates a two-lead part about the grabbed hole', () => {
    const r = movePart(frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')] }), 'R1', { from: H('B2'), to: H('B2'), turns: 1 })
    expect(r.board.parts[0]).toMatchObject({ at: 'B2', to: 'E2', rotation: 0 })
  })

  it('writes `to` when a two-lead part without one is rotated', () => {
    const { to: _to, ...noTo } = axial('R1', 'B2', 'B5', 'N1')
    const b = frozen({ parts: [noTo as Part] })
    expect(b.parts[0]!.to).toBeUndefined()
    const r = movePart(b, 'R1', { from: H('B2'), to: H('B2'), turns: 1 })
    expect(r.reason).toBeNull()
    expect(r.board.parts[0]!.to).toBe('E2')
    expect(parseBoard(r.board).ok).toBe(true)
  })

  it('adds the turns to `rotation` for other footprints', () => {
    const b = frozen({ parts: [dip8('U1', 'E5')] })
    const r1 = movePart(b, 'U1', { from: H('E5'), to: H('E5'), turns: 1 })
    expect(r1.board.parts[0]).toMatchObject({ at: 'E5', rotation: 90 })
    const b2 = frozen({ parts: [dip8('U1', 'E5', 270)] })
    const r3 = movePart(b2, 'U1', { from: H('E5'), to: H('E5'), turns: 3 })
    expect(r3.board.parts[0]!.rotation).toBe(180)
  })

  it('moves and turns the part\'s own leg folds with it', () => {
    const b = frozen({
      parts: [axial('R1', 'B2', 'B5', 'N1'), axial('R2', 'H2', 'H5', 'N2')],
      legFolds: [{ lead: 'R1.a', to: 'C2' }, { lead: 'R2.a', to: 'I2' }]
    })
    const r = movePart(b, 'R1', { from: H('B2'), to: H('E3'), turns: 0 })
    expect(r.board.legFolds).toEqual([{ lead: 'R1.a', to: 'F3' }, { lead: 'R2.a', to: 'I2' }])
    const t = movePart(b, 'R1', { from: H('B2'), to: H('B2'), turns: 1 })
    expect(t.board.legFolds[0]).toEqual({ lead: 'R1.a', to: 'B1' })
    expect(t.board.legFolds[1]).toEqual({ lead: 'R2.a', to: 'I2' })
  })

  it('refuses a pin off the board, and still returns the moved board', () => {
    const r = movePart(frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')] }), 'R1', { from: H('B2'), to: H('B9'), turns: 0 })
    expect(r.reason).toBe('R1 would be off the board.')
    expect(r.board.parts[0]!.at).toBe('B9')
  })

  it('refuses a fold that would land off the board', () => {
    const b = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')], legFolds: [{ lead: 'R1.a', to: 'A2' }] })
    // moving up one row puts the pins on row A but the fold on row 0, which has no name
    const r = movePart(b, 'R1', { from: H('B2'), to: H('A2'), turns: 0 })
    expect(r.reason).toBe('R1 would be off the board.')
    expect(r.board).toEqual(b)
    // a fold past the last row has a name, and the moved board shows it
    const f = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')], legFolds: [{ lead: 'R1.a', to: 'C2' }] })
    const g = movePart(f, 'R1', { from: H('B2'), to: H('J2'), turns: 0 })
    expect(g.reason).toBe('R1 would be off the board.')
    expect(g.board.legFolds[0]!.to).toBe('K2')
  })

  it('lets a body hang over the edge when every pin is on the board', () => {
    const b = frozen({ parts: [{ ref: 'J1', footprint: 'header-1x3', at: 'A5', rotation: 0, pins: {} }] })
    const r = movePart(b, 'J1', { from: H('A5'), to: H('A8'), turns: 0 })
    expect(r.board.parts[0]!.at).toBe('A8')
    expect(r.reason).toBeNull()
  })

  it('refuses a pin or a fold on a blocked hole, with the hole\'s reason', () => {
    const blocked = [{ holes: ['E6'], reason: 'screw' }]
    const r = movePart(frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')], board: { blocked } }), 'R1', { from: H('B2'), to: H('E3'), turns: 0 })
    expect(r.reason).toBe('Hole E6 is blocked: screw')
    const f = frozen({
      parts: [axial('R1', 'B2', 'B5', 'N1')], legFolds: [{ lead: 'R1.a', to: 'C2' }],
      board: { blocked: [{ holes: ['F3'], reason: 'screw' }] }
    })
    expect(movePart(f, 'R1', { from: H('B2'), to: H('E3'), turns: 0 }).reason).toBe('Hole F3 is blocked: screw')
  })

  it('refuses a new shared lead hole', () => {
    const b = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1'), axial('R2', 'F2', 'F5', 'N2')] })
    const r = movePart(b, 'R1', { from: H('B2'), to: H('F2'), turns: 0 })
    expect(r.reason).toBe('R1 would share hole F2 with R2.')
  })

  it('refuses landing over another part\'s leg, or a leg under another body', () => {
    const b = frozen({ parts: [dip8('U1', 'A1'), axial('R1', 'F2', 'F5', 'N1')] })
    // U1 at A1 covers B2 (col 2, row B)
    const r = movePart(b, 'R1', { from: H('F2'), to: H('B2'), turns: 0 })
    expect(r.reason).toBe('A leg of R1 would be under U1.')

    const c = frozen({ parts: [dip8('U1', 'A1'), axial('R2', 'E5', 'H5', 'N2')] })
    const u = movePart(c, 'U1', { from: H('A1'), to: H('D4'), turns: 0 })
    expect(u.reason).toBe('U1 would sit over a leg of R2.')
  })

  it('refuses a new body overlap', () => {
    const b = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1'), axial('R2', 'F4', 'I4', 'N2')] })
    const r = movePart(b, 'R2', { from: H('F4'), to: H('A4'), turns: 0 })
    expect(r.reason).toBe('R2 would overlap R1.')
  })

  it('allows a conflict the board already had (same two parts, same rule)', () => {
    const b = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1'), axial('R2', 'A4', 'D4', 'N2')] })
    const r = movePart(b, 'R2', { from: H('A4'), to: H('A3'), turns: 0 })
    expect(r.board.parts[1]).toMatchObject({ at: 'A3', to: 'D3' })
    expect(r.reason).toBeNull()
  })

  it('adds no joints and changes no wiring when a part lands on a trail', () => {
    const b = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')], trails: [trail('T1', ['E2', 'E8'])] })
    const r = movePart(b, 'R1', { from: H('B2'), to: H('E3'), turns: 0 })
    expect(r.reason).toBeNull()
    expect(r.board.trails).toEqual(b.trails)
    expect(r.board.wires).toEqual(b.wires)
  })

  it('answers "No part X." for an unknown ref', () => {
    const b = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')] })
    const r = movePart(b, 'R9', { from: H('B2'), to: H('E3'), turns: 0 })
    expect(r.reason).toBe('No part R9.')
    expect(r.board).toEqual(b)
  })
})
