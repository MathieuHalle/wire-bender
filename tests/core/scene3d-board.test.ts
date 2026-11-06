import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseBoard, type BoardFile } from '~core/schema'
import { buildScene } from '~core/scene3d'
import { mk } from './helpers'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

describe('scene3d board', () => {
  it('board slab matches the 2D outline', () => {
    const b = board2()
    const { cols, rows, pitchMm } = b.board
    const s = buildScene(b)
    expect(s.board.widthMm).toBeCloseTo((cols - 1) * pitchMm + pitchMm)
    expect(s.board.depthMm).toBeCloseTo((rows - 1) * pitchMm + pitchMm)
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
})
