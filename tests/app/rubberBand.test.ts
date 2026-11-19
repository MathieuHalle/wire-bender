import { describe, expect, it } from 'vitest'
import { bandEnd } from '../../app/utils/rubberBand'
import { holeExists } from '~core/boardShape'
import { parseHole, type Hole } from '~core/holes'
import type { BoardFile } from '~core/schema'

const H = parseHole
type Board = BoardFile['board']
const board = (shape?: Board['shape']): Board => ({ cols: 10, rows: 10, pitchMm: 2.54, type: 'one-sided', blocked: [], ...(shape ? { shape } : {}) })
const on = (b: Board) => (h: Hole) => holeExists(b, h)

describe('bandEnd (the pencil\'s rubber band)', () => {
  it('follows the row or column the pointer is further along, to the hole it rounds to', () => {
    const b = on(board())
    expect(bandEnd(H('C3'), 6.2, 3.4, b)).toEqual(H('C6'))
    expect(bandEnd(H('C3'), 3.3, 7.6, b)).toEqual(H('H3'))
    expect(bandEnd(H('C3'), 3, 3, b)).toEqual(H('C3'))
  })

  it('stops at the board\'s edge', () => {
    expect(bandEnd(H('C3'), 14, 3, on(board()))).toEqual(H('C10'))
    expect(bandEnd(H('C3'), 3, -4, on(board()))).toEqual(H('A3'))
  })

  it('stops at the last hole before a cut corner', () => {
    // A 3-hole notch at the top left: A1..A3 are missing.
    const b = on(board({ kind: 'corners', corners: { topLeft: { cut: 'notch', holes: 3 } } }))
    expect(bandEnd(H('A8'), 1, 1, b)).toEqual(H('A4'))
    expect(bandEnd(H('H1'), 1, 1, b)).toEqual(H('D1'))
  })

  it('stops inside a round board\'s circle', () => {
    const b = board({ kind: 'round' })
    const end = bandEnd(H('E5'), 1, 5, on(b))
    expect(holeExists(b, end)).toBe(true)
    expect(holeExists(b, { col: end.col - 1, row: end.row })).toBe(false)
  })
})
