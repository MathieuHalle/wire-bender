import { describe, it, expect } from 'vitest'
import { parseBoard } from '~core/schema'

/** A board file as raw JSON: tests break it on purpose, so every field is loose. */
type Obj = Record<string, unknown>
interface RawBoard {
  [k: string]: unknown
  revision?: number
  board: Obj
  bench?: Obj
  parts: unknown[]
  trails: unknown[]
  wires: Obj[]
}

const minimal = (): RawBoard => ({
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
    const j = minimal()
    j.parts = [{ ref: 'R1', footprint: 'axial', at: 'Z99', rotation: 0, pins: {} }]
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const e = r.errors.find(x => x.includes('parts[0].at'))!
      expect(e).toContain('outside the 18 x 24 board')
    }
  })
  it('rejects a diagonal trail step', () => {
    const j = minimal()
    j.trails = [{ id: 't1', side: 'bottom', points: ['A1', 'B2'], joints: [] }]
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => e.includes('trails[0].points[1]'))).toBe(true)
  })
  it('exempts flying wires from the straight rule, not laid wires', () => {
    const j = minimal()
    j.wires = [{ id: 'w1', kind: 'flying', side: 'top', points: ['A1', 'B2'], bareSegments: [], joints: [] }]
    expect(parseBoard(j).ok).toBe(true)
    j.wires[0]!.kind = 'laid'
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => e.includes('wires[0].points[1]'))).toBe(true)
  })
  it('defaults revision to 0', () => {
    const j = minimal()
    delete j.revision
    const r = parseBoard(j)
    expect(r.ok && r.board.revision).toBe(0)
  })
  it('defaults bench', () => {
    const j = minimal()
    delete j.bench
    const r = parseBoard(j)
    expect(r.ok && r.board.bench).toEqual({ endLeadMm: 5, bendAllowanceMm: 1, spareMm: 5, flyingSlackMm: 10, roundToMm: 5 })
  })
  it('creates nets referenced by pins implicitly', () => {
    const j = minimal()
    j.parts = [{ ref: 'R1', footprint: 'axial', at: 'A1', rotation: 0, pins: { 1: 'VCC', 2: null } }]
    const r = parseBoard(j)
    expect(r.ok && r.board.nets).toEqual({ VCC: {} })
  })
  it('reports shape errors with a path', () => {
    const j = minimal()
    j.board.cols = 'x'
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('board.cols')
  })
  it('reports unknown keys with a path instead of dropping them', () => {
    const j = minimal()
    j.parts = [{ ref: 'R1', footprint: 'axial', at: 'A1', rotaton: 90, rotation: 0, pins: {} }]
    j.extra = 1
    j.bench!.spare = 2
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some(e => e.startsWith('parts[0]') && e.includes('rotaton'))).toBe(true)
      expect(r.errors.some(e => e.includes('extra'))).toBe(true)
      expect(r.errors.some(e => e.startsWith('bench') && e.includes('spare'))).toBe(true)
    }
  })
  it('rejects duplicate part refs with a path', () => {
    const j = minimal()
    const r1 = { ref: 'R1', footprint: 'axial', at: 'A1', to: 'A4', rotation: 0, pins: {} }
    j.parts = [r1, { ...r1, ref: 'R2', at: 'C1', to: 'C4' }, { ...r1, at: 'E1', to: 'E4' }]
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toEqual(['parts[2].ref: duplicate "R1"'])
  })
  it('rejects duplicate trail and wire ids, which share one namespace', () => {
    const j = minimal()
    const t = (id: string) => ({ id, side: 'bottom', points: ['A1', 'A2'], joints: [] })
    const w = (id: string) => ({ id, kind: 'flying', side: 'bottom', points: ['C1', 'C5'], bareSegments: [], joints: [] })
    j.trails = [t('T1'), t('T2'), t('T3'), t('T4'), t('T3')]
    j.wires = [w('W2'), w('W2'), w('T1')]
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toEqual(['trails[4].id: duplicate "T3"', 'wires[1].id: duplicate "W2"', 'wires[2].id: duplicate "T1"'])
  })
  it('rejects top-side trails and top-side wire joints on a one-sided board', () => {
    const j = minimal()
    j.trails = [{ id: 'T1', side: 'top', points: ['A1', 'A3'], joints: [] }]
    j.wires = [
      { id: 'W1', kind: 'laid', side: 'top', points: ['C1', 'C5'], bareSegments: [], joints: ['C3'] },
      { id: 'W2', kind: 'flying', side: 'top', points: ['E1', 'E5'], bareSegments: [], joints: [] }
    ]
    const r = parseBoard(j)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toEqual([
      'trails[0].side: this board has no pads on the top side',
      'wires[0].joints[0]: this board has no pads on the top side'
    ])
    j.board.type = 'two-sided'
    expect(parseBoard(j).ok).toBe(true)
  })
})
