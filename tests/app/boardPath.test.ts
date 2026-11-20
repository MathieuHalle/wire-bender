import { describe, expect, it } from 'vitest'
import { boardPath, mountRings, noGoCells } from '../../app/utils/boardPath'
import { makeGeo, sideExtent } from '../../app/utils/boardView'
import { mk } from '../core/helpers'

const p = 2.54

describe('the board with features in 2D', () => {
  const corner = { x: -3, y: -3, diameterMm: 3.2, clearanceMm: 3 }
  const b = mk({ board: { cutouts: [{ kind: 'grid', from: 'C3', to: 'D5' }], mountingHoles: [corner] } })
  it('grows the edge round a mounting hole in the margin', () => {
    const g = makeGeo(b, 'none')
    expect(g.edge.x0).toBeCloseTo(-3 - 1.6 - 1.5)
    expect(g.edge.x1).toBeCloseTo(9.5 * p)
    expect(sideExtent(g, []).y0).toBeCloseTo(-3 - 1.6 - 1.5)
    // Mirrored left↔right, the grown edge is on the right.
    const m = makeGeo(b, 'lr')
    expect(m.edge.x1).toBeCloseTo(9 * p + 3 + 1.6 + 1.5)
  })
  it('draws the outline with the cutout and the drilled hole as subpaths', () => {
    const d = boardPath(b, makeGeo(b, 'none'))
    expect(d.match(/M/g)).toHaveLength(3)
    expect(d).toContain(`M${1.5 * p} ${1.5 * p}H${4.5 * p}V${3.5 * p}H${1.5 * p}Z`)
  })
  it('rings the clearance and hatches the holes it blocks', () => {
    expect(mountRings(b, makeGeo(b, 'none'))).toEqual([{ cx: -3, cy: -3, r: 4.6 }])
    expect(noGoCells(b, makeGeo(b, 'none')).map(c => `${c.k}:${c.reason}`)).toEqual(['A1:mounting hole'])
  })
  it('leaves a plain board\'s edge where it was', () => {
    expect(makeGeo(mk(), 'none').edge).toEqual({ x0: -p / 2, y0: -p / 2, x1: 9.5 * p, y1: 9.5 * p })
  })
})
