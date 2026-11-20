import { describe, expect, it } from 'vitest'
import { addGridCutout, addMountingHole, addZone, removeFeatureAt } from '~core/editFeatures'
import { parseHole } from '~core/holes'
import { mk } from './helpers'

const H = parseHole
const p = 2.54

describe('the Block tool edits', () => {
  it('a no-go zone over a rectangle of holes, with its reason', () => {
    const r = addZone(mk(), H('B2'), H('C4'), 'heatsink')
    expect(r.ok && r.board.board.blocked).toEqual([{ holes: ['B2', 'B3', 'B4', 'C2', 'C3', 'C4'], reason: 'heatsink' }])
  })
  it('a cutout, corners in either order; refused at the edge', () => {
    const r = addGridCutout(mk(), H('E6'), H('C3'), 'slot')
    expect(r.ok && r.board.board.cutouts).toEqual([{ kind: 'grid', from: 'C3', to: 'E6', reason: 'slot' }])
    expect(addGridCutout(mk(), H('A1'), H('B2'), '')).toEqual({ ok: false, reason: 'Can\'t add a cutout A1–B2: reaches the board\'s edge (make it a corner cut or a smaller cutout).' })
  })
  it('a mounting hole snapped to half a pitch', () => {
    const r = addMountingHole(mk(), { x: 0.6 * p, y: -0.4 * p }, 'M3')
    expect(r.ok && r.board.board.mountingHoles).toEqual([{ x: 0.5 * p, y: -0.5 * p, diameterMm: 3.2, clearanceMm: 1.5 }])
  })
  it('takes away what is under the click: mounting hole, cutout, zone', () => {
    const b = mk({ board: { blocked: [{ holes: ['H8'], reason: 'keep clear' }], cutouts: [{ kind: 'grid', from: 'C3', to: 'D5' }], mountingHoles: [{ x: 0, y: 0, diameterMm: 3.2, clearanceMm: 1.5 }] } })
    const m = removeFeatureAt(b, { x: 0.5, y: 0.5 })!
    expect(m.ok && m.what).toBe('the mounting hole')
    expect(m.ok && 'mountingHoles' in m.board.board).toBe(false)
    expect(removeFeatureAt(b, { x: 3 * p, y: 3 * p })).toMatchObject({ ok: true, what: 'the cutout' })
    expect(removeFeatureAt(b, { x: 7 * p, y: 7 * p })).toMatchObject({ ok: true, what: 'the no-go zone (keep clear)' })
    expect(removeFeatureAt(b, { x: 8 * p, y: 8 * p })).toBeNull()
  })
})
