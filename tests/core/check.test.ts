import { describe, it, expect } from 'vitest'
import { runCheck, type Finding, type RuleId } from '~core/check'
import { mk, axial, trail, type BoardOverrides } from './helpers'

const check = (over: BoardOverrides) => runCheck(mk(over))
const only = (fs: Finding[], rule: RuleId) => fs.filter(f => f.rule === rule)

const classes = {
  netClasses: { HV12: {}, LOGIC: {}, GND: {} },
  nets: { V12: { class: 'HV12' }, IN_A: { class: 'LOGIC' }, IN_B: { class: 'LOGIC' }, GND: { class: 'GND' } }
}

describe('runCheck', () => {
  it('trail one hole short -> openNet', () => {
    const { findings } = check({
      parts: [axial('R1', 'C2', 'F2', 'N'), axial('R2', 'C5', 'F5', 'N')],
      trails: [trail('T1', ['C2', 'C4'])]
    })
    const open = only(findings, 'openNet')
    expect(open).toHaveLength(1)
    expect(open[0]!.severity).toBe('error')
    expect(open[0]!.holes).toEqual(['C2', 'C5'])
    expect(open[0]!.message).toContain('N')
    expect(open[0]!.message).toContain('R1.a')
    expect(open[0]!.message).toContain('R2.a')
    expect(only(findings, 'short')).toEqual([])
  })

  it('trail into the wrong pin -> short', () => {
    const { findings } = check({
      parts: [axial('R1', 'A2', 'D2', 'N'), axial('R2', 'A8', 'D8', 'N'), axial('R3', 'A5', 'D5', 'M')],
      trails: [trail('T1', ['A2', 'A5'])]
    })
    const shorts = only(findings, 'short')
    expect(shorts).toHaveLength(1)
    expect(shorts[0]!.severity).toBe('error')
    expect(shorts[0]!.message).toMatch(/nets M and N are joined/)
    expect(shorts[0]!.message).toContain('R1.a')
    expect(shorts[0]!.message).toContain('R3.a')
    expect(shorts[0]!.holes).toEqual(expect.arrayContaining(['A2', 'A5']))
  })

  it('short lists the leads per net and the contacts it touches', () => {
    const { findings } = check({
      parts: [axial('R1', 'C2', 'F2', 'N'), axial('R2', 'C8', 'F8', 'N'), axial('R3', 'C5', 'F5', 'M')],
      trails: [trail('T1', ['C2', 'C8'])]
    })
    const shorts = only(findings, 'short')
    expect(shorts).toHaveLength(1)
    expect(shorts[0]!.message).toBe('Short: nets M and N are joined. M: R3.a; N: R1.a, R2.a. Touches: trail T1 passes over R3.a at C5.')
    expect(shorts[0]!.holes[0]).toBe('C5')
  })

  it('short lists the leads per net and never presents a same-net pass as the cause', () => {
    const { findings } = check({
      parts: [axial('R1', 'C2', 'F2', 'N'), axial('R2', 'C5', 'F5', 'N'), axial('R3', 'C8', 'F8', 'M')],
      trails: [trail('T1', ['C2', 'C8'])]
    })
    const shorts = only(findings, 'short')
    expect(shorts).toHaveLength(1)
    expect(shorts[0]!.message).toContain('M: R3.a')
    expect(shorts[0]!.message).toContain('N: R1.a, R2.a')
    expect(shorts[0]!.message).toBe('Short: nets M and N are joined. M: R3.a; N: R1.a, R2.a. Touches: trail T1 passes over R2.a at C5.')
  })

  it('short without contacts has no Touches part', () => {
    const { findings } = check({
      parts: [axial('R1', 'A2', 'D2', 'N'), axial('R3', 'A5', 'D5', 'M')],
      trails: [trail('T1', ['A2', 'A5'])]
    })
    expect(only(findings, 'short').map(f => f.message)).toEqual(['Short: nets M and N are joined. M: R3.a; N: R1.a.'])
  })

  it('a crossing is named once in the short', () => {
    const { findings } = check({
      parts: [axial('R1', 'C2', 'F2', 'N'), axial('R2', 'C8', 'F8', 'N'), axial('R3', 'F4', 'F7', 'M')],
      trails: [trail('T1', ['C2', 'C8']), trail('T2', ['A4', 'H4'])]
    })
    const shorts = only(findings, 'short')
    expect(shorts).toHaveLength(1)
    expect(shorts[0]!.message.match(/C4/g)).toHaveLength(1)
    expect(shorts[0]!.message).toContain('crosses')
    expect(shorts[0]!.message).toContain('R3.a at F4')
  })

  it('swapped inputs -> short on both', () => {
    const { findings } = check({
      parts: [
        axial('R1', 'A1', 'A4', 'IN_A'), axial('R2', 'A6', 'A9', 'IN_B'),
        axial('R3', 'J1', 'J4', 'IN_B'), axial('R4', 'J6', 'J9', 'IN_A')
      ],
      trails: [trail('T1', ['A1', 'J1']), trail('T2', ['A6', 'J6'])]
    })
    const msgs = findings.filter(f => f.rule === 'short' || f.rule === 'openNet').map(f => f.message).join('\n')
    expect(msgs).toContain('IN_A')
    expect(msgs).toContain('IN_B')
    expect(only(findings, 'short')).toHaveLength(2)
  })

  it('two legs in one hole -> twoInOneHole', () => {
    const { findings } = check({
      parts: [axial('R1', 'C2', 'C5', 'N', 'M'), axial('R2', 'C5', 'C8', 'M', 'P')]
    })
    const t = only(findings, 'twoInOneHole')
    expect(t).toHaveLength(1)
    expect(t[0]!.severity).toBe('error')
    expect(t[0]!.holes).toEqual(['C5'])
    expect(t[0]!.message).toContain('R1.b')
    expect(t[0]!.message).toContain('R2.a')
  })

  it('a lead and a wire end in one hole -> twoInOneHole', () => {
    const { findings } = check({
      parts: [axial('R1', 'C2', 'F2', 'N')],
      wires: [{ id: 'W1', kind: 'flying', side: 'top', points: ['C2', 'H8'], bareSegments: [], joints: [] }]
    })
    const t = only(findings, 'twoInOneHole')
    expect(t).toHaveLength(1)
    expect(t[0]!.holes).toEqual(['C2'])
    expect(t[0]!.message).toContain('W1')
    expect(t[0]!.message).toContain('R1.a')
  })

  it('12 V next to a logic line -> adjacent level mcu', () => {
    const { findings } = check({
      ...classes,
      rules: { keepAway: [], adjacency: [{ classes: ['HV12', 'LOGIC'], level: 'mcu' }] },
      parts: [axial('R1', 'C2', 'F2', 'V12'), axial('R2', 'C3', 'F3', 'IN_A')]
    })
    const adj = only(findings, 'adjacent')
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ severity: 'caution', level: 'mcu', holes: ['C2', 'C3'] })
    expect(adj[0]!.message).toContain('V12')
    expect(adj[0]!.message).toContain('IN_A')
  })

  it('HV12 next to GND -> adjacent level supply (class order does not matter)', () => {
    const { findings } = check({
      ...classes,
      rules: { keepAway: [], adjacency: [{ classes: ['GND', 'HV12'], level: 'supply' }] },
      parts: [axial('R1', 'C2', 'F2', 'V12'), axial('R2', 'C3', 'F3', 'GND')]
    })
    expect(only(findings, 'adjacent').map(f => f.level)).toEqual(['supply'])
  })

  it('two LOGIC nets next to each other -> harmless', () => {
    const { findings } = check({
      ...classes,
      rules: { keepAway: [], adjacency: [{ classes: ['HV12', 'LOGIC'], level: 'mcu' }] },
      parts: [axial('R1', 'C2', 'F2', 'IN_A'), axial('R2', 'C3', 'F3', 'IN_B')]
    })
    expect(only(findings, 'adjacent').map(f => f.level)).toEqual(['harmless'])
  })

  it('neighbouring pins of the same header -> harmless', () => {
    const { findings } = check({
      ...classes,
      rules: { keepAway: [], adjacency: [{ classes: ['HV12', 'LOGIC'], level: 'mcu' }] },
      parts: [{ ref: 'J1', footprint: 'header-1x5', at: 'C2', rotation: 0, pins: { 1: 'V12', 2: 'IN_A', 3: null, 4: null, 5: null } }]
    })
    const adj = only(findings, 'adjacent')
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ level: 'harmless', holes: ['C2', 'C3'] })
  })

  it('keepAway counts trail holes', () => {
    const base = {
      ...classes,
      rules: { keepAway: [{ a: 'LOGIC', b: 'HV12', holes: 1 }], adjacency: [] },
      parts: [axial('R1', 'E5', 'H5', 'IN_A'), axial('R2', 'A6', 'A9', 'V12')]
    }
    expect(only(check(base).findings, 'keepAway')).toEqual([])
    const ka = only(check({ ...base, trails: [trail('T1', ['A6', 'J6'])] }).findings, 'keepAway')
    expect(ka).toHaveLength(1)
    expect(ka[0]!.severity).toBe('warning')
    expect(ka[0]!.holes).toEqual(expect.arrayContaining(['E5', 'E6']))
    expect(ka[0]!.message).toContain('IN_A')
    expect(ka[0]!.message).toContain('V12')
  })

  it('NC pin never warns', () => {
    const { findings } = check({
      parts: [{
        ref: 'U1', footprint: 'dip8', at: 'C3', rotation: 0,
        pins: { 1: null, 2: 'X', 3: 'X', 4: 'X', 5: 'Y', 6: 'Y', 7: 'Y', 8: null }
      }],
      trails: [trail('T1', ['D3', 'F3'], 'bottom', ['E3']), trail('T2', ['D6', 'F6'], 'bottom', ['E6'])]
    })
    expect(only(findings, 'singleLeadNet')).toEqual([])
    expect(only(findings, 'openNet')).toEqual([])
    expect(findings).toEqual([])
  })

  it('a net with one lead -> singleLeadNet', () => {
    const { findings } = check({ parts: [axial('R1', 'C2', 'F2', 'N')] })
    const s = only(findings, 'singleLeadNet')
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ severity: 'warning', holes: ['C2'] })
    expect(s[0]!.message).toContain('R1.a')
  })

  it('wire end in a terminal\'s covered row -> underBody', () => {
    const { findings } = check({
      parts: [{ ref: 'J1', footprint: 'terminal-2p-508', at: 'C3', rotation: 0, pins: { 1: null, 2: null } }],
      wires: [{ id: 'W1', kind: 'flying', side: 'top', points: ['C4', 'H4'], bareSegments: [], joints: [] }]
    })
    const u = only(findings, 'underBody')
    expect(u).toHaveLength(1)
    expect(u[0]).toMatchObject({ severity: 'error', holes: ['C4'] })
    expect(u[0]!.message).toContain('J1')
    expect(u[0]!.message).toContain('W1')
  })

  it('a bottom-side trail under a body is fine, a top-side one is not', () => {
    const parts = [axial('R1', 'C2', 'C6', null)]
    expect(only(check({ parts, trails: [trail('T1', ['A4', 'H4'])] }).findings, 'underBody')).toEqual([])
    const u = only(check({ board: { type: 'two-sided' }, parts, trails: [trail('T1', ['A4', 'H4'], 'top')] }).findings, 'underBody')
    expect(u.map(f => f.holes)).toEqual([['C4']])
  })

  it('contention: two out pins in one group', () => {
    const { findings } = check({
      parts: [
        { ...axial('R1', 'C2', 'F2', 'N'), roles: { a: 'out' } },
        { ...axial('R2', 'C8', 'F8', 'N'), roles: { a: 'out' } }
      ],
      trails: [trail('T1', ['C2', 'C8'])]
    })
    const c = only(findings, 'contention')
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ severity: 'error', holes: ['C2', 'C8'] })
    expect(c[0]!.message).toContain('R1.a')
    expect(c[0]!.message).toContain('R2.a')
  })

  it('bodies overlapping -> bodyCollision; touching is fine', () => {
    const crossed = check({ parts: [axial('R1', 'C2', 'C6', null), axial('R2', 'A4', 'E4', null)] })
    const b = only(crossed.findings, 'bodyCollision')
    expect(b).toHaveLength(1)
    expect(b[0]!.severity).toBe('error')
    expect(b[0]!.message).toContain('R1')
    expect(b[0]!.message).toContain('R2')
    const side = check({ parts: [axial('R1', 'C2', 'F2', null), axial('R2', 'C3', 'F3', null)] })
    expect(only(side.findings, 'bodyCollision')).toEqual([])
  })

  it('lead and trail in a blocked hole -> blockedHole', () => {
    const { findings } = check({
      board: { blocked: [{ holes: ['E5', 'H8'], reason: 'mounting hole' }] },
      parts: [axial('R1', 'E5', 'H5', null)],
      trails: [trail('T1', ['H6', 'H9'])]
    })
    const b = only(findings, 'blockedHole')
    expect(b.map(f => f.holes)).toEqual([['E5'], ['H8']])
    expect(b[0]!.message).toContain('R1.a')
    expect(b[0]!.message).toContain('mounting hole')
    expect(b[1]!.message).toContain('T1')
  })

  it('pins off the board -> blockedHole', () => {
    const { findings } = check({
      parts: [{ ref: 'J1', footprint: 'header-1x5', at: 'C8', rotation: 0, pins: { 1: null, 2: null, 3: null, 4: null, 5: null } }]
    })
    const b = only(findings, 'blockedHole')
    expect(b).toHaveLength(2)
    expect(b.every(f => f.severity === 'error')).toBe(true)
    expect(b[0]!.message).toContain('J1.4')
    expect(b[0]!.message).toContain('off the board')
    expect(b[1]!.message).toContain('J1.5')
  })

  it('missingJoint for a same-net leg passed over', () => {
    const { findings } = check({
      parts: [axial('R1', 'C2', 'F2', 'N'), axial('R2', 'C8', 'F8', 'N'), axial('R3', 'C5', 'F5', 'N')],
      trails: [trail('T1', ['C2', 'C8'])]
    })
    const m = only(findings, 'missingJoint')
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ severity: 'warning', holes: ['C5'] })
    expect(m[0]!.message).toContain('T1')
    expect(findings.filter(f => f.severity === 'error')).toEqual([])
  })

  it('a same-net crossing gives one missingJoint, not two', () => {
    const { findings } = check({
      parts: [axial('R1', 'C2', 'F2', 'N'), axial('R2', 'C8', 'F8', 'N'), axial('R3', 'H4', 'H7', 'N')],
      trails: [trail('T1', ['C2', 'C8']), trail('T2', ['A4', 'H4'])]
    })
    const m = only(findings, 'missingJoint')
    expect(m.map(f => f.holes)).toEqual([['C4']])
    expect(m[0]!.message).toContain('T1')
    expect(m[0]!.message).toContain('T2')
  })

  it('orders findings errors, warnings, cautions, then rule, then hole; counts stats', () => {
    const { findings, stats } = check({
      ...classes,
      parts: [
        axial('R1', 'C2', 'F2', 'IN_A'), axial('R2', 'C3', 'F3', 'IN_B'),
        axial('R3', 'H2', 'H5', 'V12'), axial('R4', 'H5', 'H8', null)
      ]
    })
    const sev = findings.map(f => f.severity)
    expect(sev).toEqual([...sev].sort((a, b) => ['error', 'warning', 'caution'].indexOf(a) - ['error', 'warning', 'caution'].indexOf(b)))
    expect(findings.map(f => `${f.rule}:${f.holes[0]}`)).toEqual([
      'twoInOneHole:H5',
      'singleLeadNet:C2', 'singleLeadNet:C3', 'singleLeadNet:H2',
      'adjacent:C2'
    ])
    // Nets with a lead: IN_A, IN_B, V12 (GND has none). Groups with a lead: R1.a, R1.b, R2.a,
    // R2.b, R3.a, {R3.b, R4.a} (same hole), R4.b.
    expect(stats).toEqual({ nets: 3, groups: 7, errors: 1, warnings: 3, cautions: 1 })
  })
})
