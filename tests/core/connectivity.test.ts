import { describe, it, expect } from 'vitest'
import { buildConnectivity, type Connectivity } from '~core/connectivity'
import { holeName, parseHole } from '~core/holes'
import { mk, axial, trail } from './helpers'

const groupOfTrail = (c: Connectivity, id: string) =>
  c.groups.findIndex(g => g.conductors.some(x => x.kind === 'trail' && x.id === id))
const groupOfWire = (c: Connectivity, id: string) =>
  c.groups.findIndex(g => g.conductors.some(x => x.kind === 'wire' && x.id === id))

// N at C2 and C8 (pin a of vertical axials), optional lead of net M at C5.
const rowC = (withM: boolean) => [
  axial('R1', 'C2', 'F2', 'N'),
  axial('R2', 'C8', 'F8', 'N'),
  ...(withM ? [axial('R3', 'C5', 'F5', 'M')] : [])
]

describe('buildConnectivity', () => {
  it('trail joins two leads', () => {
    const c = buildConnectivity(mk({
      parts: [axial('R1', 'C2', 'C5', null, 'N'), axial('R2', 'F5', 'F8', 'N')],
      trails: [trail('T1', ['C5', 'F5'])]
    }))
    expect(c.groupOfLead.get('R1.b')).toBeDefined()
    expect(c.groupOfLead.get('R1.b')).toBe(c.groupOfLead.get('R2.a'))
    expect(c.groupOfLead.get('R1.a')).not.toBe(c.groupOfLead.get('R1.b'))
    const g = c.groups[c.groupOfLead.get('R1.b')!]!
    expect(g.nets).toEqual(['N'])
    expect([...g.leads].sort()).toEqual(['R1.b', 'R2.a'])
    expect(groupOfTrail(c, 'T1')).toBe(c.groupOfLead.get('R1.b'))
  })

  it('trail over other-net leg is a short', () => {
    const c = buildConnectivity(mk({ parts: rowC(true), trails: [trail('T1', ['C2', 'C8'])] }))
    const gi = groupOfTrail(c, 'T1')
    expect(c.groups[gi]!.nets).toEqual(['M', 'N'])
    expect(c.groupOfLead.get('R3.a')).toBe(gi)
    expect(c.contacts).toEqual([
      { hole: parseHole('C5'), side: 'bottom', trailId: 'T1', with: 'R3.a', sameNet: false }
    ])
    expect(c.proposedJoints).toEqual([])
    expect(c.netAtHole(parseHole('C5'), 'bottom')).toBeNull()
  })

  it('trail over empty hole makes no contact', () => {
    const c = buildConnectivity(mk({ parts: rowC(false), trails: [trail('T1', ['C2', 'C8'])] }))
    expect(c.groups[groupOfTrail(c, 'T1')]!.nets).toEqual(['N'])
    expect(c.contacts).toEqual([])
    expect(c.proposedJoints).toEqual([])
    expect(c.netAtHole(parseHole('C5'), 'bottom')).toBe('N')
    expect(c.netAtHole(parseHole('C2'), 'bottom')).toBe('N')
    expect(c.netAtHole(parseHole('E5'), 'bottom')).toBeNull()
  })

  it('proposed joint for same-net leg passed over', () => {
    const parts = [...rowC(false), axial('R3', 'C5', 'F5', 'N')]
    const c = buildConnectivity(mk({ parts, trails: [trail('T1', ['C2', 'C8'])] }))
    expect(c.proposedJoints).toEqual([{ trailId: 'T1', hole: parseHole('C5') }])
    expect(c.contacts).toEqual([
      { hole: parseHole('C5'), side: 'bottom', trailId: 'T1', with: 'R3.a', sameNet: true }
    ])
    expect(c.groupOfLead.get('R3.a')).toBe(groupOfTrail(c, 'T1'))
  })

  it('no proposed joint where the trail already lists one', () => {
    const parts = [...rowC(false), axial('R3', 'C5', 'F5', 'N')]
    const c = buildConnectivity(mk({ parts, trails: [trail('T1', ['C2', 'C8'], 'bottom', ['C5'])] }))
    expect(c.proposedJoints).toEqual([])
    expect(c.contacts).toEqual([])
    expect(c.groupOfLead.get('R3.a')).toBe(groupOfTrail(c, 'T1'))
  })

  it('passing over a bend point counts', () => {
    const c = buildConnectivity(mk({
      parts: [axial('R1', 'C2', 'F2', 'N'), axial('R2', 'C5', 'F5', 'M')],
      trails: [trail('T1', ['A2', 'C2', 'C5', 'A5'])]
    }))
    // C2 and C5 are bend points, not endpoints or joints: contact rule applies at both.
    expect(c.contacts.map(x => [holeName(x.hole), x.with])).toEqual([['C2', 'R1.a'], ['C5', 'R2.a']])
    expect(c.groups[groupOfTrail(c, 'T1')]!.nets).toEqual(['M', 'N'])
  })

  it('floating trail over two legs of different nets is a short, not two same-net contacts', () => {
    const c = buildConnectivity(mk({
      parts: [axial('R1', 'C3', 'F3', 'N'), axial('R2', 'C6', 'F6', 'M')],
      trails: [trail('T1', ['C1', 'C9'])]
    }))
    expect(c.groups[groupOfTrail(c, 'T1')]!.nets).toEqual(['M', 'N'])
    expect(c.contacts).toEqual([
      { hole: parseHole('C3'), side: 'bottom', trailId: 'T1', with: 'R1.a', sameNet: false },
      { hole: parseHole('C6'), side: 'bottom', trailId: 'T1', with: 'R2.a', sameNet: false }
    ])
    expect(c.proposedJoints).toEqual([])
  })

  it('short through a chain of contacts proposes no joints', () => {
    // T1 carries N; floating T2 crosses it at C4 and passes over an M leg at F4.
    const c = buildConnectivity(mk({
      parts: [...rowC(false), axial('R3', 'F4', 'F7', 'M')],
      trails: [trail('T1', ['C2', 'C8']), trail('T2', ['A4', 'H4'])]
    }))
    expect(groupOfTrail(c, 'T1')).toBe(groupOfTrail(c, 'T2'))
    expect(c.groups[groupOfTrail(c, 'T1')]!.nets).toEqual(['M', 'N'])
    expect(c.contacts.length).toBeGreaterThan(0)
    expect(c.contacts.every(x => !x.sameNet)).toBe(true)
    expect(c.contacts.map(x => [x.trailId, x.with, holeName(x.hole)]).sort()).toEqual([
      ['T1', 'T2', 'C4'], ['T2', 'R3.a', 'F4'], ['T2', 'T1', 'C4']
    ])
    expect(c.proposedJoints).toEqual([])
  })

  it('two bare trails crossing at a hole touch', () => {
    const c = buildConnectivity(mk({
      trails: [trail('T1', ['B3', 'F3']), trail('T2', ['D1', 'D6'])]
    }))
    expect(groupOfTrail(c, 'T1')).toBe(groupOfTrail(c, 'T2'))
    expect(c.contacts.map(x => [x.trailId, x.with, holeName(x.hole)]).sort()).toEqual([
      ['T1', 'T2', 'D3'], ['T2', 'T1', 'D3']
    ])
  })

  it('trails on opposite sides crossing do not touch', () => {
    const c = buildConnectivity(mk({
      board: { type: 'two-sided' },
      trails: [trail('T1', ['B3', 'F3'], 'top'), trail('T2', ['D1', 'D6'])]
    }))
    expect(groupOfTrail(c, 'T1')).not.toBe(groupOfTrail(c, 'T2'))
    expect(c.contacts).toEqual([])
  })

  it('trail over a solder joint of another trail touches it', () => {
    const c = buildConnectivity(mk({
      trails: [trail('T1', ['B3', 'F3']), trail('T2', ['D3', 'D6'])]
    }))
    // T2 ends (is soldered) at D3, which T1 passes over.
    expect(groupOfTrail(c, 'T1')).toBe(groupOfTrail(c, 'T2'))
    expect(c.contacts.map(x => [x.trailId, x.with, holeName(x.hole)])).toEqual([['T1', 'T2', 'D3']])
  })

  it('trail over a solder bridge end touches it', () => {
    const c = buildConnectivity(mk({
      parts: [axial('R1', 'A8', 'D8', 'N')],
      trails: [trail('T1', ['B3', 'F3'])],
      solderBridges: [{ side: 'bottom', a: 'D3', b: 'D4' }, { side: 'bottom', a: 'D4', b: 'D5' }]
    }))
    expect(c.contacts.map(x => [x.trailId, holeName(x.hole)])).toEqual([['T1', 'D3']])
    expect(c.groups[groupOfTrail(c, 'T1')]!.conductors).toContainEqual({ kind: 'pad', hole: parseHole('D5'), side: 'bottom' })
  })

  it('sides don\'t connect through an empty hole', () => {
    const c = buildConnectivity(mk({
      board: { type: 'two-sided' },
      trails: [trail('T1', ['B2', 'B6'], 'top'), trail('T2', ['B6', 'B9'])]
    }))
    expect(c.groups).toHaveLength(2)
    expect(groupOfTrail(c, 'T1')).not.toBe(groupOfTrail(c, 'T2'))
  })

  it('wire end joins both sides with a top joint', () => {
    const c = buildConnectivity(mk({
      board: { type: 'two-sided' },
      trails: [trail('T1', ['B2', 'B6'], 'top', ['B6']), trail('T2', ['B6', 'B9'])],
      wires: [{ id: 'W1', kind: 'flying', side: 'bottom', points: ['B6', 'H3'], bareSegments: [], joints: [] }]
    }))
    expect(c.groups).toHaveLength(1)
    expect(groupOfWire(c, 'W1')).toBe(groupOfTrail(c, 'T1'))
  })

  it('lead joins the top pad only when the top side is soldered there', () => {
    const base = { board: { type: 'two-sided' as const }, parts: [axial('R1', 'C2', 'F2', 'N')] }
    const off = buildConnectivity(mk({ ...base, trails: [trail('T1', ['C2', 'C9'], 'top', [])] }))
    // Top trail passes its end over the lead: it is soldered there (endpoint), so it joins.
    expect(off.groupOfLead.get('R1.a')).toBe(groupOfTrail(off, 'T1'))
    const none = buildConnectivity(mk({ ...base, trails: [trail('T1', ['C3', 'C9'], 'top', [])] }))
    expect(none.groupOfLead.get('R1.a')).not.toBe(groupOfTrail(none, 'T1'))
  })

  it('leg fold joins the target pad', () => {
    const board = { rows: 12 }
    const parts = [axial('D1', 'L4', 'L1', null, 'N')]
    const trails = [trail('T1', ['L2', 'H2'])]
    const c = buildConnectivity(mk({ board, parts, trails, legFolds: [{ lead: 'D1.b', to: 'L2' }] }))
    expect(c.groupOfLead.get('D1.b')).toBe(groupOfTrail(c, 'T1'))
    const noFold = buildConnectivity(mk({ board, parts, trails }))
    expect(noFold.groupOfLead.get('D1.b')).not.toBe(groupOfTrail(noFold, 'T1'))
  })

  it('insulated wire segment makes no contact', () => {
    const c = buildConnectivity(mk({
      parts: rowC(true),
      wires: [{ id: 'W1', kind: 'laid', side: 'bottom', points: ['C2', 'C8'], bareSegments: [], joints: [] }]
    }))
    expect(c.groupOfLead.get('R3.a')).not.toBe(groupOfWire(c, 'W1'))
    expect(c.groupOfLead.get('R1.a')).toBe(groupOfWire(c, 'W1'))
    expect(c.groupOfLead.get('R2.a')).toBe(groupOfWire(c, 'W1'))
    expect(c.groups[groupOfWire(c, 'W1')]!.nets).toEqual(['N'])
    expect(c.contacts).toEqual([])
  })

  it('bare wire segment behaves like a trail', () => {
    const c = buildConnectivity(mk({
      parts: rowC(true),
      wires: [{ id: 'W1', kind: 'laid', side: 'bottom', points: ['C2', 'C4', 'C8'], bareSegments: [1], joints: [] }]
    }))
    expect(c.groupOfLead.get('R3.a')).toBe(groupOfWire(c, 'W1'))
    expect(c.contacts).toEqual([
      { hole: parseHole('C5'), side: 'bottom', trailId: 'W1', with: 'R3.a', sameNet: false }
    ])
  })

  it('flying wire path makes no contact', () => {
    const c = buildConnectivity(mk({
      parts: rowC(true),
      wires: [{ id: 'W1', kind: 'flying', side: 'bottom', points: ['C2', 'C8'], bareSegments: [0], joints: [] }]
    }))
    expect(c.groupOfLead.get('R3.a')).not.toBe(groupOfWire(c, 'W1'))
    expect(c.contacts).toEqual([])
  })

  it('one-sided board has no top pads', () => {
    // parseBoard refuses this; connectivity still ignores top solder if handed such a board.
    const two = mk({ board: { type: 'two-sided' }, trails: [trail('T1', ['B2', 'B6'], 'top', ['B4'])] })
    const c = buildConnectivity({ ...two, board: { ...two.board, type: 'one-sided' } })
    expect(c.groups.flatMap(g => g.conductors).filter(x => x.kind === 'pad')).toEqual([])
  })

  it('a trail over an NC leg touches it but proposes no joint there', () => {
    const c = buildConnectivity(mk({
      parts: [axial('R1', 'B2', 'B5', 'N'), axial('R2', 'F2', 'F5', 'N'), axial('R3', 'D2', 'D7', null)],
      trails: [trail('T1', ['B2', 'F2'])]
    }))
    expect(c.contacts.map(x => [x.trailId, x.with, holeName(x.hole)])).toEqual([['T1', 'R3.a', 'D2']])
    expect(c.proposedJoints).toEqual([])
  })

  it('groupAtHole: the pad on that side, then what goes through, then what lies over', () => {
    const c = buildConnectivity(mk({
      board: { type: 'two-sided' },
      parts: [axial('R1', 'B2', 'B5', 'N'), axial('R2', 'H2', 'H5', 'M')],
      trails: [trail('T1', ['B5', 'E5']), trail('T2', ['G1', 'G9'], 'top')],
      wires: [{ id: 'W1', kind: 'laid', side: 'bottom', points: ['J1', 'J9'], bareSegments: [], joints: [] }]
    }))
    const at = (n: string, side: 'top' | 'bottom' = 'bottom') => c.groupAtHole(parseHole(n), side)
    expect(at('B5')).toBe(groupOfTrail(c, 'T1')) // pad
    expect(at('B5', 'top')).toBe(c.groupOfLead.get('R1.b')) // lead through the hole, no top pad
    expect(at('H2', 'top')).toBe(c.groupOfLead.get('R2.a'))
    expect(at('C5')).toBe(groupOfTrail(c, 'T1')) // over
    expect(at('G4', 'top')).toBe(groupOfTrail(c, 'T2'))
    expect(at('G4')).toBeNull()
    expect(at('J4')).toBe(groupOfWire(c, 'W1'))
    expect(at('A9')).toBeNull()
    expect(c.netAtHole(parseHole('C5'), 'bottom')).toBeNull() // T1 joins only the NC leg R1.b
    expect(c.netAtHole(parseHole('B2'), 'top')).toBe('N')
  })
})
