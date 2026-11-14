import { describe, it, expect } from 'vitest'
import { mapHole, movePart, moveWire, moveWireEnd, pickAt } from '~core/move'
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

  it('refuses a fold that would land off the board, naming the folded leg (the pins are on it)', () => {
    const b = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')], legFolds: [{ lead: 'R1.a', to: 'A2' }] })
    // moving up one row puts the pins on row A but the fold on row 0, which has no name
    const r = movePart(b, 'R1', { from: H('B2'), to: H('A2'), turns: 0 })
    expect(r.reason).toBe('R1\'s folded leg would be off the board.')
    expect(r.board).toEqual(b)
    // a fold past the last row has a name, and the moved board shows it
    const f = frozen({ parts: [axial('R1', 'B2', 'B5', 'N1')], legFolds: [{ lead: 'R1.a', to: 'C2' }] })
    const g = movePart(f, 'R1', { from: H('B2'), to: H('J2'), turns: 0 })
    expect(g.reason).toBe('R1\'s folded leg would be off the board.')
    expect(g.board.legFolds[0]!.to).toBe('K2')
    // pins off too: the part itself is off the board
    expect(movePart(f, 'R1', { from: H('B2'), to: H('B9'), turns: 0 }).reason).toBe('R1 would be off the board.')
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

const wire = (id: string, points: string[], opts: Partial<{ kind: 'laid' | 'flying', side: 'top' | 'bottom', bareSegments: number[], joints: string[] }> = {}) =>
  ({ id, kind: 'laid' as const, side: 'bottom' as const, points, bareSegments: [] as number[], joints: [] as string[], ...opts })
const flying = (id: string, points: string[]) => wire(id, points, { kind: 'flying' })

describe('moveWire', () => {
  it('moves a whole laid wire with its shape, joints and bare stretches', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5', 'D5'], { joints: ['B5'], bareSegments: [1] })] })
    const r = moveWire(b, 'W1', { from: H('B2'), to: H('C3'), turns: 0 })
    expect(r.reason).toBeNull()
    expect(r.board.wires[0]).toMatchObject({ points: ['C3', 'C6', 'E6'], joints: ['C6'], bareSegments: [1] })
  })

  it('turns a whole wire about the grabbed hole and keeps it straight', () => {
    const b = frozen({ wires: [wire('W1', ['B5', 'B8', 'D8'])] })
    const r = moveWire(b, 'W1', { from: H('B5'), to: H('B5'), turns: 1 })
    expect(r.reason).toBeNull()
    expect(r.board.wires[0]!.points).toEqual(['B5', 'E5', 'E3'])
    expect(parseBoard(r.board).ok).toBe(true)
  })

  it('refuses a wire point off the board or on a blocked hole', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])] })
    expect(moveWire(b, 'W1', { from: H('B2'), to: H('B8'), turns: 0 }).reason).toBe('Wire W1 would be off the board.')
    const up = moveWire(b, 'W1', { from: H('B2'), to: H('A2'), turns: 3 })
    expect(up.reason).toBe('Wire W1 would be off the board.')
    expect(up.board).toEqual(b)
    const blocked = frozen({ wires: [wire('W1', ['B2', 'B5'])], board: { blocked: [{ holes: ['E6'], reason: 'screw' }] } })
    expect(moveWire(blocked, 'W1', { from: H('B2'), to: H('E3'), turns: 0 }).reason).toBe('Hole E6 is blocked: screw')
  })

  it('answers "No wire X." for an unknown id', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])] })
    const r = moveWire(b, 'W9', { from: H('B2'), to: H('C3'), turns: 0 })
    expect(r.reason).toBe('No wire W9.')
    expect(r.board).toEqual(b)
  })
})

describe('moveWireEnd', () => {
  it('lengthens or shortens a laid wire when the new end is in line', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])] })
    const r = moveWireEnd(b, 'W1', 'last', H('B7'), 'row-first')
    expect(r.reason).toBeNull()
    expect(r.board.wires[0]!.points).toEqual(['B2', 'B7'])
    expect(moveWireEnd(b, 'W1', 'last', H('B3'), 'row-first').board.wires[0]!.points).toEqual(['B2', 'B3'])
  })

  it('adds one corner, row first, then column first with Tab', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])] })
    const row = moveWireEnd(b, 'W1', 'last', H('E7'), 'row-first')
    expect(row.reason).toBeNull()
    expect(row.board.wires[0]!.points).toEqual(['B2', 'B7', 'E7'])
    expect(moveWireEnd(b, 'W1', 'last', H('E7'), 'col-first').board.wires[0]!.points).toEqual(['B2', 'E2', 'E7'])
    expect(parseBoard(row.board).ok).toBe(true)
  })

  it('moves the first end too, shifting bare segment numbers', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5', 'E5'], { bareSegments: [1] })] })
    const r = moveWireEnd(b, 'W1', 'first', H('D3'), 'row-first')
    expect(r.board.wires[0]).toMatchObject({ points: ['D3', 'B3', 'B5', 'E5'], bareSegments: [2] })
    expect(parseBoard(r.board).ok).toBe(true)
  })

  it('the two runs of the L are bare when the run they replace was bare', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'], { bareSegments: [0] })] })
    expect(moveWireEnd(b, 'W1', 'last', H('E7'), 'row-first').board.wires[0]!.bareSegments).toEqual([0, 1])
    const c = frozen({ wires: [wire('W1', ['B2', 'B5'])] })
    expect(moveWireEnd(c, 'W1', 'last', H('E7'), 'row-first').board.wires[0]!.bareSegments).toEqual([])
  })

  it('the end joint moves with the end; joints the wire no longer reaches are dropped', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B8'], { joints: ['B8', 'B6'] })] })
    const r = moveWireEnd(b, 'W1', 'last', H('B4'), 'row-first')
    expect(r.reason).toBeNull()
    expect(r.board.wires[0]!.joints).toEqual(['B4'])
  })

  it('refuses an end landing on the point before it', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])] })
    const r = moveWireEnd(b, 'W1', 'last', H('B2'), 'row-first')
    expect(r.reason).toBe('The end can\'t land on the point before it.')
  })

  it('moves a flying wire end anywhere, but not onto its other end', () => {
    const b = frozen({ wires: [flying('W1', ['B2', 'H9'])] })
    const r = moveWireEnd(b, 'W1', 'last', H('C4'), 'row-first')
    expect(r.reason).toBeNull()
    expect(r.board.wires[0]!.points).toEqual(['B2', 'C4'])
    expect(moveWireEnd(b, 'W1', 'last', H('B2'), 'row-first').reason).toBe('Both ends of wire W1 would be in B2.')
  })

  it('refuses a new end on a blocked hole', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])], board: { blocked: [{ holes: ['E7'], reason: 'screw' }] } })
    expect(moveWireEnd(b, 'W1', 'last', H('E7'), 'row-first').reason).toBe('Hole E7 is blocked: screw')
  })

  it('answers "No wire X." for an unknown id', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])] })
    const r = moveWireEnd(b, 'W9', 'last', H('E7'), 'row-first')
    expect(r.reason).toBe('No wire W9.')
    expect(r.board).toEqual(b)
  })

  it('refuses a target above row A or left of column 1 without throwing', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])] })
    for (const t of [{ col: 3, row: 0 }, { col: 0, row: 3 }]) {
      const r = moveWireEnd(b, 'W1', 'last', t, 'row-first')
      expect(r.reason).toBe('Wire W1 would be off the board.')
      expect(r.board).toEqual(b)
    }
  })

  it('refuses a new corner on a blocked hole', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B5'])], board: { blocked: [{ holes: ['B7'], reason: 'screw' }] } })
    expect(moveWireEnd(b, 'W1', 'last', H('E7'), 'row-first').reason).toBe('Hole B7 is blocked: screw')
    expect(moveWireEnd(b, 'W1', 'last', H('E7'), 'col-first').reason).toBeNull()
  })

  it('writes a joint once when the end lands on an existing joint', () => {
    const b = frozen({ wires: [wire('W1', ['B2', 'B8'], { joints: ['B8', 'B4'] })] })
    expect(moveWireEnd(b, 'W1', 'last', H('B4'), 'row-first').board.wires[0]!.joints).toEqual(['B4'])
  })
})

describe('pickAt', () => {
  const flying = (id: string, points: string[], side: 'top' | 'bottom' = 'bottom') =>
    ({ id, kind: 'flying' as const, side, points, bareSegments: [], joints: [] })
  const laid = (id: string, points: string[], side: 'top' | 'bottom' = 'bottom') =>
    ({ id, kind: 'laid' as const, side, points, bareSegments: [], joints: [] })

  it('an end hole picks that end', () => {
    const b = mk({ wires: [laid('W1', ['B2', 'B6'])] })
    expect(pickAt(b, 'bottom', { col: 6, row: 2 })).toEqual({ kind: 'wire-end', id: 'W1', end: 'last', at: H('B6') })
  })

  it('a hole the wire passes picks the whole wire', () => {
    const b = mk({ wires: [laid('W1', ['B2', 'B6'])] })
    expect(pickAt(b, 'bottom', { col: 4, row: 2 })).toEqual({ kind: 'wire', id: 'W1', at: H('B4') })
  })

  it('the line of a 2-hole jumper picks the whole wire', () => {
    const b = mk({ wires: [laid('W1', ['B2', 'B3'])] })
    expect(pickAt(b, 'bottom', { col: 2.5, row: 2 })).toEqual({ kind: 'wire', id: 'W1', at: H('B2') })
  })

  it('a flying wire is picked by its ends only', () => {
    const b = mk({ wires: [flying('W1', ['B2', 'H9'])] })
    expect(pickAt(b, 'bottom', { col: 2, row: 2 })).toEqual({ kind: 'wire-end', id: 'W1', end: 'first', at: H('B2') })
    expect(pickAt(b, 'bottom', { col: 5, row: 5 })).toBeNull()
  })

  it('parts are picked on the top side only', () => {
    const b = mk({ parts: [axial('R1', 'B2', 'B5', null)] })
    expect(pickAt(b, 'top', { col: 3, row: 2 })).toEqual({ kind: 'part', ref: 'R1', at: H('B3') })
    expect(pickAt(b, 'bottom', { col: 3, row: 2 })).toBeNull()
  })

  it('a wire drawn over a part wins', () => {
    const b = mk({
      board: { type: 'two-sided' },
      parts: [axial('R1', 'B2', 'B5', null)],
      wires: [laid('W1', ['A3', 'D3'], 'top')]
    })
    expect(pickAt(b, 'top', { col: 3, row: 2 })).toMatchObject({ kind: 'wire', id: 'W1' })
  })

  it('only items of the given side', () => {
    const b = mk({ board: { type: 'two-sided' }, wires: [laid('W1', ['B2', 'B6'])] })
    expect(pickAt(b, 'top', { col: 4, row: 2 })).toBeNull()
  })

  it('empty board -> null', () => {
    expect(pickAt(mk(), 'top', { col: 4, row: 4 })).toBeNull()
  })
})
