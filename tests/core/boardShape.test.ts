import { describe, expect, it } from 'vitest'
import { boardOutline, existingHoles, holeExists, outlinePoints, shapeOutline } from '~core/boardShape'
import { holeMm, holeName, parseHole, type Hole } from '~core/holes'
import { parseBoard, type BoardFile, type BoardShape } from '~core/schema'
import { mk } from './helpers'

const H = parseHole
const settings = (cols: number, rows: number, shape?: BoardShape): BoardFile['board'] =>
  ({ cols, rows, pitchMm: 2.54, type: 'one-sided', blocked: [], ...(shape ? { shape } : {}) })
const grid = (b: BoardFile['board']): Hole[] => {
  const out: Hole[] = []
  for (let row = 1; row <= b.rows; row++) for (let col = 1; col <= b.cols; col++) out.push({ col, row })
  return out
}
const names = (b: BoardFile['board']) => grid(b).filter(h => !holeExists(b, h)).map(holeName)

/** Ray casting: is (x, y) inside the polygon? */
function inside(points: { x: number, y: number }[], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!
    const b = points[j]!
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

/** Distance from (x, y) to the polygon's nearest edge. */
function edgeDistance(points: { x: number, y: number }[], x: number, y: number): number {
  let best = Infinity
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!
    const b = points[i]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)))
  }
  return best
}

describe('holeExists', () => {
  it('without a shape: every hole of the grid, none outside it', () => {
    const b = settings(4, 3)
    expect(names(b)).toEqual([])
    expect(holeExists(b, { col: 5, row: 1 })).toBe(false)
    expect(holeExists(b, { col: 0, row: 1 })).toBe(false)
  })

  it('a round 2 × 2 keeps its four holes', () => {
    expect(names(settings(2, 2, { kind: 'round' }))).toEqual([])
  })

  it('a round 10 × 10 loses its corners', () => {
    const b = settings(10, 10, { kind: 'round' })
    for (const n of ['A1', 'J10', 'B2']) expect(holeExists(b, H(n))).toBe(false)
    for (const n of ['E1', 'A5', 'C2']) expect(holeExists(b, H(n))).toBe(true)
  })

  it('a notch removes the block at its corner', () => {
    const b = settings(10, 10, { kind: 'corners', corners: { topLeft: { cut: 'notch', holes: 2 } } })
    expect(names(b)).toEqual(['A1', 'A2', 'B1', 'B2'])
  })

  it('a chamfer removes the holes nearer the corner than its 45° line', () => {
    const b = settings(10, 10, { kind: 'corners', corners: { bottomRight: { cut: 'chamfer', holes: 2 } } })
    expect(names(b).sort()).toEqual(['I10', 'J10', 'J9'].sort())
    expect(holeExists(b, H('I9'))).toBe(true)
  })

  it('existingHoles lists exactly the holes that exist, row by row', () => {
    const b = settings(10, 10, { kind: 'round' })
    const e = existingHoles(b)
    expect(e.length).toBe(grid(b).filter(h => holeExists(b, h)).length)
    expect(holeName(e[0]!)).toBe('A4')
  })
})

describe('boardOutline', () => {
  const shapes: [string, BoardFile['board']][] = [
    ['plain', settings(7, 5)],
    ['round', settings(10, 10, { kind: 'round' })],
    ['round, not square', settings(12, 7, { kind: 'round' })],
    ['notches', settings(12, 8, { kind: 'corners', corners: { topLeft: { cut: 'notch', holes: 2 }, bottomRight: { cut: 'notch', holes: 3 } } })],
    ['chamfers', settings(12, 8, { kind: 'corners', corners: { topRight: { cut: 'chamfer', holes: 3 }, bottomLeft: { cut: 'chamfer', holes: 1 } } })]
  ]
  for (const [name, b] of shapes) {
    for (const margin of [0.5, 1.5])
      it(`holds every existing hole (${name}, margin ${margin})`, () => {
        const pts = outlinePoints(b, margin)
        for (const h of existingHoles(b)) {
          const m = holeMm(h, b.pitchMm)
          expect(inside(pts, m.x, m.y), holeName(h)).toBe(true)
        }
      })
    it(`a missing hole is outside the outline or within ¼ pitch of its edge (${name})`, () => {
      const pts = outlinePoints(b, 0.5)
      for (const h of grid(b).filter(x => !holeExists(b, x))) {
        const m = holeMm(h, b.pitchMm)
        expect(!inside(pts, m.x, m.y) || edgeDistance(pts, m.x, m.y) < 0.25 * b.pitchMm + 1e-6, holeName(h)).toBe(true)
      }
    })
  }

  it('a plain board is today\'s rectangle, half a pitch past the outer holes', () => {
    const o = boardOutline(settings(3, 2))
    expect(o.kind).toBe('polygon')
    const xs = (o as { points: { x: number, y: number }[] }).points.map(p => p.x)
    const ys = (o as { points: { x: number, y: number }[] }).points.map(p => p.y)
    expect(Math.min(...xs)).toBeCloseTo(-1.27)
    expect(Math.max(...xs)).toBeCloseTo(2 * 2.54 + 1.27)
    expect(Math.max(...ys)).toBeCloseTo(2.54 + 1.27)
  })

  it('a round board is a circle on the grid\'s middle, as wide as its shorter side', () => {
    expect(boardOutline(settings(10, 10, { kind: 'round' }))).toEqual({ kind: 'circle', cx: 4.5 * 2.54, cy: 4.5 * 2.54, r: 5 * 2.54 })
  })
})

describe('shapeOutline (the outline as a side draws it)', () => {
  const same = { x: (v: number) => v, y: (v: number) => v }
  it('a plain board has none: the side draws its own rectangle', () => {
    expect(shapeOutline(settings(6, 4), same)).toBeNull()
  })

  it('a notch at the top left is drawn top right on a side mirrored left-right', () => {
    const b = settings(10, 10, { kind: 'corners', corners: { topLeft: { cut: 'notch', holes: 2 } } })
    const span = 9 * 2.54
    const lr = { x: (v: number) => span - v, y: (v: number) => v }
    // The notch's inside corner, between B2 and C3 (board mm 1.5 pitch, 1.5 pitch).
    const pts = (shapeOutline(b, lr) as { kind: 'polygon', points: { x: number, y: number }[] }).points
    expect(pts.some(p => Math.abs(p.x - (span - 1.5 * 2.54)) < 1e-9 && Math.abs(p.y - 1.5 * 2.54) < 1e-9)).toBe(true)
    expect(pts.some(p => Math.abs(p.x - 1.5 * 2.54) < 1e-9 && Math.abs(p.y - 1.5 * 2.54) < 1e-9)).toBe(false)
  })

  it('a round board is its circle, centre mapped', () => {
    expect(shapeOutline(settings(10, 10, { kind: 'round' }), same)).toEqual({ kind: 'circle', cx: 4.5 * 2.54, cy: 4.5 * 2.54, r: 5 * 2.54 })
  })
})

describe('the shape in the board file', () => {
  // mk() refuses an invalid board, so the shape goes onto a valid one afterwards.
  const board = (shape: unknown, cols = 10, rows = 10): BoardFile => {
    const b = JSON.parse(JSON.stringify(mk({ board: { cols, rows } }))) as BoardFile
    if (shape !== undefined) (b.board as Record<string, unknown>).shape = shape
    return b
  }
  const errors = (b: BoardFile) => {
    const r = parseBoard(b)
    return r.ok ? [] : r.errors
  }

  it('round and corner shapes parse; no shape parses as before', () => {
    expect(errors(board({ kind: 'round' }))).toEqual([])
    expect(errors(board({ kind: 'corners', corners: { topLeft: { cut: 'notch', holes: 2 }, bottomRight: { cut: 'chamfer', holes: 3 } } }))).toEqual([])
    expect(errors(board(undefined))).toEqual([])
  })

  it('a bad cut is an error', () => {
    expect(errors(board({ kind: 'corners', corners: { topLeft: { cut: 'notch', holes: 0 } } })).length).toBeGreaterThan(0)
    expect(errors(board({ kind: 'corners', corners: { middle: { cut: 'notch', holes: 1 } } })).length).toBeGreaterThan(0)
    expect(errors(board({ kind: 'corners', corners: { topLeft: { cut: 'round', holes: 1 } } })).length).toBeGreaterThan(0)
  })

  it('cuts on opposite corners that overlap or meet are an error: the board would split', () => {
    const corners = (c: Record<string, unknown>, size: number) => errors(board({ kind: 'corners', corners: c }, size, size))
    // 3 × 3: the two notches leave only A1 and C3, and the outline crosses itself.
    expect(corners({ topRight: { cut: 'notch', holes: 2 }, bottomLeft: { cut: 'notch', holes: 2 } }, 3))
      .toEqual(['board.shape: the topRight and bottomLeft corner cuts overlap or meet, splitting the board'])
    // 4 × 4: the notches' inside corners touch at one point.
    expect(corners({ topRight: { cut: 'notch', holes: 2 }, bottomLeft: { cut: 'notch', holes: 2 } }, 4))
      .toEqual(['board.shape: the topRight and bottomLeft corner cuts overlap or meet, splitting the board'])
    expect(corners({ topLeft: { cut: 'chamfer', holes: 4 }, bottomRight: { cut: 'notch', holes: 3 } }, 5))
      .toEqual(['board.shape: the topLeft and bottomRight corner cuts overlap or meet, splitting the board'])
  })

  it('cuts that keep the board in one piece still parse (what the form makes, too)', () => {
    const ok = (c: Record<string, unknown>, cols: number, rows: number) => expect(errors(board({ kind: 'corners', corners: c }, cols, rows))).toEqual([])
    ok({ topLeft: { cut: 'notch', holes: 2 }, bottomRight: { cut: 'chamfer', holes: 3 } }, 10, 10)
    const all = (cut: string, holes: number) => ({ topLeft: { cut, holes }, topRight: { cut, holes }, bottomLeft: { cut, holes }, bottomRight: { cut, holes } })
    ok(all('notch', 2), 5, 5)
    ok(all('chamfer', 2), 5, 5)
    ok(all('notch', 3), 12, 8)
  })

  it('cuts that leave an edge without a hole are an error, named', () => {
    expect(errors(board({ kind: 'corners', corners: { topLeft: { cut: 'notch', holes: 5 }, topRight: { cut: 'chamfer', holes: 5 } } })))
      .toEqual(['board.shape: the top edge\'s corner cuts leave no hole (5 + 5 of 10)'])
    // A 1-row board: any cut empties its left or right edge.
    expect(errors(board({ kind: 'corners', corners: { topLeft: { cut: 'notch', holes: 1 } } }, 6, 1)))
      .toEqual(['board.shape: the left edge\'s corner cuts leave no hole (1 + 0 of 1)'])
  })

  it('a round board with no hole is an error (1 wide, an even number long)', () => {
    for (const [cols, rows] of [[2, 1], [1, 4], [4, 1]])
      expect(errors(board({ kind: 'round' }, cols, rows))).toEqual([`board.shape: a round ${cols} × ${rows} board has no hole`])
    // Odd lengths keep the middle hole; 2 × 2 keeps all four.
    expect(errors(board({ kind: 'round' }, 3, 1))).toEqual([])
    expect(errors(board({ kind: 'round' }, 2, 2))).toEqual([])
  })

  it('corners with no cut is an error (no shape is written by leaving it out)', () => {
    expect(errors(board({ kind: 'corners', corners: {} })))
      .toEqual(['board.shape: corners names no corner cut (leave shape out for a rectangle)'])
  })

  it('an item on a missing hole is not a format error (the check reports it)', () => {
    const b = mk({
      board: { cols: 10, rows: 10, shape: { kind: 'round' } } as never,
      trails: [{ id: 'T1', side: 'bottom', points: ['A1', 'A3'], joints: [] }]
    })
    expect(errors(b)).toEqual([])
  })
})
