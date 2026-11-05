import { describe, it, expect } from 'vitest'
import { parseBoard } from '~core/schema'

const minimal = () => ({
  format: 'wirebender/1',
  revision: 3,
  name: 'test',
  board: { cols: 18, rows: 24, pitchMm: 2.54, type: 'one-sided', blocked: [] },
  netClasses: {},
  nets: {},
  rules: { keepAway: [], adjacency: [] },
  parts: [],
  trails: [],
  wires: [],
  legFolds: [],
  solderBridges: [],
  bench: { endLeadMm: 5, bendAllowanceMm: 1, spareMm: 5, flyingSlackMm: 10, roundToMm: 5 }
})

describe('parseBoard', () => {
  it('accepts a minimal board', () => {
    const r = parseBoard(minimal())
    expect(r.ok).toBe(true)
  })
  it('rejects out-of-grid hole with a path', () => {
    const j: any = minimal()
    j.parts = [{ ref: 'R1', footprint: 'axial', at: 'Z99', rotation: 0, pins: {} }]
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const e = r.errors.find(x => x.includes('parts[0].at'))!
      expect(e).toContain('outside the 18 x 24 board')
    }
  })
  it('rejects a diagonal trail step', () => {
    const j: any = minimal()
    j.trails = [{ id: 't1', side: 'bottom', points: ['A1', 'B2'], joints: [] }]
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => e.includes('trails[0].points[1]'))).toBe(true)
  })
  it('exempts flying wires from the straight rule, not laid wires', () => {
    const j: any = minimal()
    j.wires = [{ id: 'w1', kind: 'flying', side: 'top', points: ['A1', 'B2'], bareSegments: [], joints: [] }]
    expect(parseBoard(j).ok).toBe(true)
    j.wires[0].kind = 'laid'
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => e.includes('wires[0].points[1]'))).toBe(true)
  })
  it('defaults revision to 0', () => {
    const j: any = minimal()
    delete j.revision
    const r = parseBoard(j)
    expect(r.ok && r.board.revision).toBe(0)
  })
  it('defaults bench', () => {
    const j: any = minimal()
    delete j.bench
    const r = parseBoard(j)
    expect(r.ok && r.board.bench).toEqual({ endLeadMm: 5, bendAllowanceMm: 1, spareMm: 5, flyingSlackMm: 10, roundToMm: 5 })
  })
  it('creates nets referenced by pins implicitly', () => {
    const j: any = minimal()
    j.parts = [{ ref: 'R1', footprint: 'axial', at: 'A1', rotation: 0, pins: { 1: 'VCC', 2: null } }]
    const r = parseBoard(j)
    expect(r.ok && r.board.nets).toEqual({ VCC: {} })
  })
  it('reports shape errors with a path', () => {
    const j: any = minimal()
    j.board.cols = 'x'
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('board.cols')
  })
})
