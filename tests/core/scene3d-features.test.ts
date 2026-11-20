import { describe, expect, it } from 'vitest'
import { buildScene, COLORS, EDGE_MARGIN_PITCH } from '~core/scene3d'
import { mk } from './helpers'

const p = 2.54

describe('board features in 3D', () => {
  const s = buildScene(mk({
    board: { cutouts: [{ kind: 'grid', from: 'C3', to: 'D5' }, { kind: 'round', x: 7 * p, y: 7 * p, diameterMm: 4 }], mountingHoles: [{ x: -2, y: -2, diameterMm: 3.2, clearanceMm: 3 }], blocked: [{ holes: ['J10'], reason: 'heatsink' }] }
  }))
  it('cuts the openings through the slab', () => {
    expect(s.board.openings).toHaveLength(3)
    expect(s.board.openings![0]).toEqual([{ x: 1.5 * p, z: 1.5 * p }, { x: 4.5 * p, z: 1.5 * p }, { x: 4.5 * p, z: 3.5 * p }, { x: 1.5 * p, z: 3.5 * p }])
    expect(s.board.openings![1]).toHaveLength(48)
  })
  it('grows the slab round the mounting hole in the corner', () => {
    expect(s.board.widthMm).toBeCloseTo(9 * p + EDGE_MARGIN_PITCH * p + 2 + 1.6 + 1.5)
  })
  it('patches every blocked hole on both surfaces, with its reason, and rings the clearance', () => {
    const patches = s.prims.filter(x => x.color === COLORS.noGo)
    expect(patches.some(x => x.tag.label === 'blocked: heatsink')).toBe(true)
    expect(patches.some(x => x.tag.label === 'blocked: mounting hole')).toBe(true)
    expect(patches.length % 2).toBe(0)
    expect(s.prims.filter(x => x.color === COLORS.mountRing)).toHaveLength(2)
  })
  it('leaves a plain board without openings', () => {
    expect(buildScene(mk()).board.openings).toBeUndefined()
  })
})
