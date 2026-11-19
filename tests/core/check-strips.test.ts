import { describe, expect, it } from 'vitest'
import { runCheck } from '~core/check'
import { axial, breadboard400, mk } from './helpers'

const header = (ref: string, at: string, net: string | null) => ({ ref, footprint: 'header-1x1', at, rotation: 0 as const, pins: { 1: net } })
const supply = {
  netClasses: { pwr: {}, gnd: {} },
  nets: { VCC: { class: 'pwr' }, GND: { class: 'gnd' } },
  rules: { keepAway: [], adjacency: [{ classes: ['pwr', 'gnd'] as [string, string], level: 'supply' as const }] }
}
const rules = (b: ReturnType<typeof mk>, rule: string) => runCheck(b).findings.filter(f => f.rule === rule)
const dip8 = (at: string, rotation: 0 | 90) =>
  ({ ref: 'U1', footprint: 'dip8', at, rotation, pins: { 1: 'N1', 2: 'N2', 3: 'N3', 4: 'N4', 5: 'N5', 6: 'N6', 7: 'N7', 8: 'N8' } })

describe('adjacency along strips', () => {
  it('reports two parallel strips once, not once per hole (Focus 3)', () => {
    const b = mk({
      ...supply,
      board: { strips: [{ from: 'A1', to: 'A10' }, { from: 'B1', to: 'B10' }] },
      parts: [header('J1', 'A1', 'VCC'), header('J2', 'B10', 'GND')]
    })
    const adj = rules(b, 'adjacent')
    expect(adj).toHaveLength(1)
    expect(adj[0]!.level).toBe('supply')
    expect(adj[0]!.holes).toHaveLength(20)
    expect(adj[0]!.message).toBe('Adjacent: VCC strip A1–A10 runs next to GND strip B1–B10 (A1 next to B1, and 9 more) (shorts the supply)')
  })
  it('keeps the per-hole finding off strips', () => {
    const b = mk({ ...supply, parts: [header('J1', 'C1', 'VCC'), header('J2', 'C2', 'GND')] })
    expect(rules(b, 'adjacent').map(f => f.message)).toEqual(['Adjacent: VCC at C1 next to GND at C2 (shorts the supply)'])
  })
  it('reports nothing on a breadboard (no solder to bridge)', () => {
    const b = mk({ ...supply, board: breadboard400(), parts: [header('J1', 'D1', 'VCC'), header('J2', 'D2', 'GND')] })
    expect(rules(b, 'adjacent')).toEqual([])
  })
})

describe('shorts through strips', () => {
  it('names the strip on a stripboard', () => {
    const b = mk({ board: { strips: [{ from: 'B1', to: 'B10' }] }, parts: [axial('R1', 'B2', 'B6', 'X', 'Y')] })
    const s = rules(b, 'short')
    expect(s).toHaveLength(1)
    expect(s[0]!.message).toBe('Short: nets X and Y are joined. X: R1.a; Y: R1.b. Via: strip B1–B10.')
  })
  it('gives no short for a DIP across the breadboard channel (Focus 4)', () => {
    // Turned 90°: pins 1–4 along row H (f), 5–8 along row K (e), three rows apart.
    const b = mk({ board: breadboard400(), parts: [dip8('H5', 90)] })
    expect(rules(b, 'short')).toEqual([])
  })
  it('names the strip and says to move a part for a DIP not across it (Focus 4)', () => {
    // Not turned: pins 1–4 down column 5 (rows D–G), one clip strip.
    const b = mk({ board: breadboard400(), parts: [dip8('D5', 0)] })
    const s = rules(b, 'short')
    expect(s.length).toBeGreaterThan(0)
    expect(s[0]!.message).toContain('Via: strip j5–f5 (D5–H5).')
    expect(s[0]!.message).toMatch(/Move one of the parts to another strip\.$/)
  })
  it('names a strip a bare trail touches', () => {
    const b = mk({ board: { strips: [{ from: 'B1', to: 'B10' }] }, parts: [header('J1', 'B9', 'X'), header('J2', 'C5', 'Y')], trails: [{ id: 'T1', side: 'bottom', points: ['A5', 'C5'], joints: [] }] })
    expect(rules(b, 'short')[0]!.message).toContain('Touches: trail T1 touches strip B1–B10 at B5.')
  })
})

describe('a breadboard', () => {
  it('says nothing of solder, joints or sides', () => {
    const b = mk({
      ...supply, board: breadboard400(),
      parts: [dip8('D5', 0), header('J1', 'K20', 'VCC'), header('J2', 'L20', 'GND'), header('J3', 'A3', 'N1')],
      wires: [{ id: 'W1', kind: 'laid', side: 'top', points: ['K21', 'K24'], bareSegments: [], joints: [] }]
    })
    const msgs = runCheck(b).findings.map(f => f.message)
    expect(msgs.length).toBeGreaterThan(0)
    for (const m of msgs) expect(m).not.toMatch(/solder|joint|bottom|top side/i)
    expect(rules(b, 'missingJoint')).toEqual([])
  })
})
