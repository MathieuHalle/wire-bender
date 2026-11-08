import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseBoard, type BoardFile } from '~core/schema'
import { edgeLabels } from '~core/edgeLabels'
import { holeMm } from '~core/holes'
import { buildScene, EDGE_MARGIN_PITCH, LABEL_OFFSET_PITCH } from '~core/scene3d'
import { mk } from './helpers'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

describe('scene3d board', () => {
  it('board slab has a 1.5 pitch margin past the outer holes, for the printed numbers', () => {
    const b = board2()
    const { cols, rows, pitchMm } = b.board
    const s = buildScene(b)
    expect(EDGE_MARGIN_PITCH).toBe(1.5)
    expect(s.board.widthMm).toBeCloseTo((cols - 1) * pitchMm + 3 * pitchMm)
    expect(s.board.depthMm).toBeCloseTo((rows - 1) * pitchMm + 3 * pitchMm)
    expect(s.board.thicknessMm).toBe(1.6)
    expect(s.board.center[0]).toBeCloseTo(((cols - 1) * pitchMm) / 2)
    expect(s.board.center[1]).toBeCloseTo(-0.8)
    expect(s.board.center[2]).toBeCloseTo(((rows - 1) * pitchMm) / 2)
    expect(s.holes).toHaveLength(cols * rows)
    expect(s.holes).toContainEqual({ x: 0, z: 0 })
    expect(s.holes).toContainEqual({ x: (cols - 1) * pitchMm, z: (rows - 1) * pitchMm })
  })

  it('two-sided board has pads on both sides', () => {
    const s = buildScene(mk({ board: { type: 'two-sided', blocked: [{ holes: ['B2', 'C3'], reason: 'mount' }] } }))
    expect(s.holes).toHaveLength(100)
    expect(s.pads.top).toHaveLength(s.holes.length)
    expect(s.pads.bottom).toHaveLength(s.holes.length)
    expect(s.holes).toContainEqual({ x: 2.54, z: 2.54 }) // blocked B2 still drilled
  })

  it('one-sided board has no top pads', () => {
    const s = buildScene(mk())
    expect(s.pads.top).toHaveLength(0)
    expect(s.pads.bottom).toHaveLength(s.holes.length)
  })

  it('empty board: slab and holes only, finite bounds', () => {
    const s = buildScene(mk())
    expect(s.prims).toEqual([])
    expect(s.skipped).toEqual([])
    expect(s.holes).toHaveLength(100)
    for (const v of [...s.bounds.min, ...s.bounds.max]) expect(Number.isFinite(v)).toBe(true)
    expect(s.bounds.min[1]).toBeCloseTo(-1.6)
    expect(s.bounds.max[0]).toBeGreaterThan(s.bounds.min[0])
  })

  it('hole positions do not move with the wider margin', () => {
    const b = mk({ board: { cols: 4, rows: 3 } })
    const s = buildScene(b)
    const expected = []
    for (let row = 1; row <= 3; row++)
      for (let col = 1; col <= 4; col++) {
        const m = holeMm({ col, row }, 2.54)
        expected.push({ x: m.x, z: m.y })
      }
    expect(s.holes).toEqual(expected)
    expect(s.holes[0]).toEqual({ x: 0, z: 0 })
    expect(s.holes.at(-1)!.x).toBeCloseTo(3 * 2.54)
    expect(s.holes.at(-1)!.z).toBeCloseTo(2 * 2.54)
    // Centred on the holes as before, so parts, wires and the camera still line up.
    expect(s.board.center[0]).toBeCloseTo(1.5 * 2.54)
    expect(s.board.center[2]).toBeCloseTo(2.54)
  })
})

describe('edge labels', () => {
  it('numbers columns 1..cols and letters rows A.., the same for 2D and 3D', () => {
    expect(edgeLabels(3, 2)).toEqual({
      cols: [{ col: 1, text: '1' }, { col: 2, text: '2' }, { col: 3, text: '3' }],
      rows: [{ row: 1, text: 'A' }, { row: 2, text: 'B' }]
    })
    const big = edgeLabels(60, 40)
    expect(big.cols.at(-1)).toEqual({ col: 60, text: '60' })
    expect(big.rows[25]).toEqual({ row: 26, text: 'Z' })
    expect(big.rows.at(-1)).toEqual({ row: 40, text: 'AN' })
  })

  it('scene labels: columns on the top and bottom edges, rows on the left and right, one pitch past the holes', () => {
    const p = 2.54
    const s = buildScene(mk({ board: { cols: 4, rows: 3 } }))
    expect(LABEL_OFFSET_PITCH).toBe(1)
    expect(s.labels).toHaveLength(2 * 4 + 2 * 3)
    const on = (edge: string) => s.labels.filter(l => l.edge === edge)
    const top = on('top')
    const bottom = on('bottom')
    const left = on('left')
    const right = on('right')
    expect(top.map(l => l.text)).toEqual(['1', '2', '3', '4'])
    expect(bottom.map(l => l.text)).toEqual(['1', '2', '3', '4'])
    expect(left.map(l => l.text)).toEqual(['A', 'B', 'C'])
    expect(right.map(l => l.text)).toEqual(['A', 'B', 'C'])
    top.forEach((l, i) => {
      expect(l.x).toBeCloseTo(i * p)
      expect(l.z).toBeCloseTo(-p) // past row A
    })
    bottom.forEach((l, i) => {
      expect(l.x).toBeCloseTo(i * p)
      expect(l.z).toBeCloseTo(3 * p) // past the last row
    })
    left.forEach((l, i) => {
      expect(l.x).toBeCloseTo(-p) // past column 1
      expect(l.z).toBeCloseTo(i * p)
    })
    right.forEach((l, i) => {
      expect(l.x).toBeCloseTo(4 * p) // past the last column
      expect(l.z).toBeCloseTo(i * p)
    })
    // Every label is on the slab, inside its edge.
    const { center: [cx, , cz], widthMm, depthMm } = s.board
    for (const l of s.labels) {
      expect(Math.abs(l.x - cx)).toBeLessThan(widthMm / 2)
      expect(Math.abs(l.z - cz)).toBeLessThan(depthMm / 2)
    }
  })

  it('labels follow the pitch', () => {
    const s = buildScene(mk({ board: { cols: 2, rows: 2, pitchMm: 2 } }))
    expect(s.board.widthMm).toBeCloseTo(2 + 3 * 2)
    expect(s.labels.find(l => l.edge === 'right' && l.text === 'B')).toMatchObject({ x: 4, z: 2 })
  })
})
