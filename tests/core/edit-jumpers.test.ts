import { describe, expect, it } from 'vitest'
import { eraseSegment, jumperClick, pencilClick, toggleJoint, type Drawing } from '~core/edit'
import { movePart } from '~core/move'
import { parseHole } from '~core/holes'
import { parseBoard, type BoardFile } from '~core/schema'
import { breadboard400, mk } from './helpers'

const H = parseHole
const bb = () => mk({ board: breadboard400() })

/** Clicks the holes in turn; returns the board and the drawing after the last. */
function clicks(board: BoardFile, names: string[]) {
  let b = board
  let d: Drawing | null = null
  for (const n of names) {
    const r = jumperClick(b, H(n), d)
    if (!r.ok) throw new Error(r.reason)
    b = r.board
    d = r.drawing
  }
  return { board: b, drawing: d }
}

describe('jumperClick', () => {
  it('starts with no change, makes the wire on the second click, adds corners, ends on the last hole', () => {
    const start = bb()
    const one = clicks(start, ['D3'])
    expect(one.board).toBe(start)
    expect(one.drawing).toEqual({ trailId: 'W1', side: 'top', jumper: true, start: 'D3' })
    const r = clicks(start, ['D3', 'D9', 'K9', 'K9'])
    expect(r.drawing).toBeNull()
    expect(r.board.wires).toEqual([{ id: 'W1', kind: 'laid', side: 'top', points: ['D3', 'D9', 'K9'], bareSegments: [], joints: [] }])
    expect(parseBoard(r.board).ok).toBe(true)
  })
  it('refuses a diagonal and a missing hole', () => {
    const { board, drawing } = clicks(bb(), ['D3'])
    expect(jumperClick(board, H('E4'), drawing)).toEqual({ ok: false, reason: 'Jumpers run along a row or a column here: click a hole in the same row or column.' })
    expect(jumperClick(board, H('I3'), null)).toEqual({ ok: false, reason: 'Hole I3 is off the board.' })
  })
  it('ends a one-click jumper with nothing left behind', () => {
    const { board } = clicks(bb(), ['D3', 'D3'])
    expect(board.wires).toEqual([])
  })
})

describe('erase on a breadboard', () => {
  it('takes the whole jumper out', () => {
    const { board } = clicks(bb(), ['D3', 'D9', 'K9', 'K9'])
    const r = eraseSegment(board, 'top', H('D5'), H('D6'))
    expect(r.ok && r.board.wires).toEqual([])
  })
})

describe('no solder tools on a breadboard', () => {
  const reason = 'A breadboard has no solder: the pencil draws jumpers.'
  it('refuses the trail pencil and joints', () => {
    expect(pencilClick(bb(), 'bottom', H('D3'), null)).toEqual({ ok: false, reason })
    expect(toggleJoint(bb(), 'bottom', H('D3'))).toEqual({ ok: false, reason })
  })
  it('moves a part without making a leg fold', () => {
    const b = mk({ board: breadboard400(), parts: [{ ref: 'U1', footprint: 'dip8', at: 'H5', rotation: 90, pins: {} }] })
    const r = movePart(b, 'U1', { from: H('H5'), to: H('H9'), turns: 0 })
    expect(r.reason).toBeNull()
    expect(r.board.legFolds).toEqual([])
    expect(r.board.parts[0]!.at).toBe('H9')
  })
})
