import { describe, expect, it } from 'vitest'
import { existingHoles, holeExists } from '~core/boardShape'
import { runCheck } from '~core/check'
import { pencilClick } from '~core/edit'
import { blockedZones, cutoutShape } from '~core/features'
import { holeName, parseHole } from '~core/holes'
import { parseBoard } from '~core/schema'
import { mk } from './helpers'

const H = parseHole
const p = 2.54
const raw = (board: Record<string, unknown>) => ({
  format: 'wirebender/1', revision: 0, name: 't',
  board: { cols: 10, rows: 10, pitchMm: p, type: 'one-sided', blocked: [], ...board },
  netClasses: {}, nets: {}, rules: { keepAway: [], adjacency: [] },
  parts: [], trails: [], wires: [], legFolds: [], solderBridges: []
})
const errs = (board: Record<string, unknown>) => {
  const r = parseBoard(raw(board))
  return r.ok ? [] : r.errors
}
const missing = (b: ReturnType<typeof mk>['board']) =>
  Array.from({ length: 100 }, (_, i) => ({ col: (i % 10) + 1, row: Math.floor(i / 10) + 1 })).filter(h => !holeExists(b, h)).map(holeName)

describe('cutouts', () => {
  it('a grid cutout removes its holes and nothing around them', () => {
    const b = mk({ board: { cutouts: [{ kind: 'grid', from: 'C3', to: 'D5' }] } }).board
    expect(missing(b)).toEqual(['C3', 'C4', 'C5', 'D3', 'D4', 'D5'])
    expect(cutoutShape(b, b.cutouts![0]!)).toEqual({ kind: 'rect', x0: 1.5 * p, y0: 1.5 * p, x1: 4.5 * p, y1: 3.5 * p })
  })
  it('a round cutout removes the holes within a quarter pitch of it', () => {
    // A 6 mm hole centred on E5: E5 (0 mm), its neighbours (2.54 mm < 3 + 0.635) go, diagonals (3.59 mm) too.
    const b = mk({ board: { cutouts: [{ kind: 'round', x: 4 * p, y: 4 * p, diameterMm: 6 }] } }).board
    expect(missing(b)).toEqual(['D4', 'D5', 'D6', 'E4', 'E5', 'E6', 'F4', 'F5', 'F6'])
  })
  it('a free rectangle in mm', () => {
    const b = mk({ board: { cutouts: [{ kind: 'rect', x: 4 * p, y: 4 * p, widthMm: 1, heightMm: 8 }] } }).board
    expect(missing(b)).toEqual(['D5', 'E5', 'F5'])
  })
  it('refuses a cutout at the edge, and two that meet', () => {
    expect(errs({ cutouts: [{ kind: 'grid', from: 'A1', to: 'B2' }] })).toEqual(['board.cutouts[0]: reaches the board\'s edge (make it a corner cut or a smaller cutout)'])
    expect(errs({ cutouts: [{ kind: 'grid', from: 'C3', to: 'D5' }, { kind: 'round', x: 4 * p, y: 2 * p, diameterMm: 2 }] }))
      .toEqual(['board.cutouts[1]: overlaps or touches board.cutouts[0]'])
  })
})

describe('mounting holes', () => {
  const m = { x: 4.5 * p, y: 4.5 * p, diameterMm: 3.2, clearanceMm: 3 }
  const b = mk({ board: { mountingHoles: [m] } }).board
  it('removes the holes under it and blocks those in its clearance', () => {
    expect(missing(b)).toEqual(['E5', 'E6', 'F5', 'F6'])
    const zone = blockedZones(b, h => holeExists(b, h)).at(-1)!
    expect(zone.reason).toBe('mounting hole')
    expect(zone.holes).toContain('D5')
    expect(zone.holes).not.toContain('E5')
  })
  it('the tools refuse a blocked hole beside it, and the check reports one used', () => {
    expect(pencilClick(mk({ board: { mountingHoles: [m] } }), 'bottom', H('D5'), null)).toEqual({ ok: false, reason: 'Hole D5 is blocked: mounting hole' })
    const used = mk({ board: { mountingHoles: [m] }, parts: [{ ref: 'J1', footprint: 'header-1x1', at: 'D5', rotation: 0, pins: { 1: 'X' } }] })
    expect(runCheck(used).findings.map(f => f.message)).toContain('Blocked hole: J1.1 at D5, which is blocked (mounting hole)')
  })
  it('may sit in the margin, not far off the board', () => {
    expect(errs({ mountingHoles: [{ x: -3, y: -3, diameterMm: 3.2 }] })).toEqual([])
    expect(errs({ mountingHoles: [{ x: -20, y: 0, diameterMm: 3.2 }] })).toEqual(['board.mountingHoles[0]: more than 10 mm outside the hole grid'])
  })
  it('a board without features keeps every hole', () => {
    expect(existingHoles(mk().board)).toHaveLength(100)
  })
})
