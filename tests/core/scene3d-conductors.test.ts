import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseBoard, type BoardFile, type Wire } from '~core/schema'
import { holeMm, parseHole } from '~core/holes'
import { buildConnectivity } from '~core/connectivity'
import { buildScene, type Prim, type V3 } from '~core/scene3d'
import { axial, mk, trail } from './helpers'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const P = 2.54
const xz = (name: string) => {
  const m = holeMm(parseHole(name), P)
  return { x: m.x, z: m.y }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps
const at = (q: V3, name: string) => near(q[0], xz(name).x) && near(q[2], xz(name).z)

type Tube = Extract<Prim, { kind: 'tube' }>
type Cone = Extract<Prim, { kind: 'cone' }>
type Cyl = Extract<Prim, { kind: 'cylinder' }>
const tubes = (prims: Prim[], kind: string, id?: string) =>
  prims.filter((p): p is Tube => p.kind === 'tube' && p.tag.kind === kind && (id === undefined || p.tag.id === id))
const cones = (prims: Prim[]) => prims.filter((p): p is Cone => p.kind === 'cone')
const cyls = (prims: Prim[]) => prims.filter((p): p is Cyl => p.kind === 'cylinder')
const coneAt = (prims: Prim[], name: string, up: 1 | -1) => cones(prims).find(c => c.up === up && at(c.base, name))

/** y of a polyline at the point (x, z) on it; undefined when it does not pass there. */
function yAt(points: V3[], x: number, z: number): number | undefined {
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i]!, points[i + 1]!]
    const dx = b[0] - a[0]
    const dz = b[2] - a[2]
    const len2 = dx * dx + dz * dz
    const t = len2 === 0 ? 0 : ((x - a[0]) * dx + (z - a[2]) * dz) / len2
    if (t < -1e-9 || t > 1 + 1e-9) continue
    if (!near(a[0] + t * dx, x, 1e-6) || !near(a[2] + t * dz, z, 1e-6)) continue
    return a[1] + t * (b[1] - a[1])
  }
  return undefined
}

const wire = (over: Partial<Wire> & Pick<Wire, 'id' | 'points'>): Wire =>
  ({ kind: 'laid', side: 'top', bareSegments: [], joints: [], ...over })

describe('scene3d conductors', () => {
  it('bottom trail lies under the board', () => {
    const s = buildScene(mk({ trails: [trail('T1', ['B2', 'B6', 'F6'], 'bottom', ['B4'])] }))
    const [t, ...rest] = tubes(s.prims, 'trail', 'T1')
    expect(rest).toHaveLength(0)
    expect(t!.radius).toBeCloseTo(0.3)
    expect(t!.color).toBe('#b87333')
    expect(t!.points).toHaveLength(3)
    for (const q of t!.points) expect(q[1]).toBeCloseTo(-1.9, 2)
    expect(at(t!.points[0]!, 'B2') && at(t!.points[1]!, 'B6') && at(t!.points[2]!, 'F6')).toBe(true)
    for (const h of ['B2', 'B4', 'F6']) {
      const c = coneAt(s.prims, h, -1)
      expect(c, h).toBeDefined()
      expect(c!.base[1]).toBeCloseTo(-1.6)
      expect(c!.tag.kind).toBe('joint')
    }
    expect(cones(s.prims).some(c => c.up === 1)).toBe(false)
  })

  it('top trail on a two-sided board lies on top with upward cones', () => {
    const s = buildScene(mk({ board: { type: 'two-sided' }, trails: [trail('T1', ['B2', 'B6'], 'top', ['B4'])] }))
    for (const q of tubes(s.prims, 'trail')[0]!.points) expect(q[1]).toBeCloseTo(0.3)
    for (const h of ['B2', 'B4', 'B6']) expect(coneAt(s.prims, h, 1)?.base[1], h).toBeCloseTo(0)
  })

  it('top trail on a one-sided board is soldered underneath', () => {
    // parseBoard rejects this, so build it two-sided and flip the type.
    const b = mk({ board: { type: 'two-sided' }, trails: [trail('T1', ['B2', 'B6'], 'top')] })
    const s = buildScene({ ...b, board: { ...b.board, type: 'one-sided' } })
    expect(cones(s.prims).some(c => c.up === 1)).toBe(false)
    for (const q of tubes(s.prims, 'trail')[0]!.points) expect(q[1]).toBeCloseTo(0.3)
    for (const h of ['B2', 'B6']) {
      expect(coneAt(s.prims, h, -1), h).toBeDefined()
      const c = cyls(s.prims).find(c => c.tag.id === 'T1' && at(c.a, h) && at(c.b, h))
      expect(c, h).toBeDefined()
      expect(Math.max(c!.a[1], c!.b[1])).toBeGreaterThanOrEqual(0)
      expect(Math.min(c!.a[1], c!.b[1])).toBeLessThanOrEqual(-1.6)
    }
  })

  it('mixed wire alternates bare and insulated', () => {
    const s = buildScene(mk({ wires: [wire({ id: 'W1', points: ['B2', 'B4', 'D4', 'D7'], bareSegments: [0, 2], color: '#ff0000' })] }))
    const ts = tubes(s.prims, 'wire', 'W1')
    expect(ts.map(t => t.radius)).toEqual([0.3, 0.7, 0.3])
    expect(ts.map(t => t.color)).toEqual(['#b87333', '#ff0000', '#b87333'])
    for (const q of ts[1]!.points) expect(q[1]).toBeCloseTo(0.7)
    for (const q of ts[0]!.points) expect(q[1]).toBeCloseTo(0.3)
    // Ends go through their holes to a cone underneath.
    for (const h of ['B2', 'D7']) {
      expect(coneAt(s.prims, h, -1), h).toBeDefined()
      expect(cyls(s.prims).some(c => c.tag.id === 'W1' && at(c.a, h) && at(c.b, h)), h).toBe(true)
    }
  })

  it('insulated wire colour falls back to the net colour, then blue', () => {
    const s = buildScene(mk({ wires: [wire({ id: 'W1', points: ['B2', 'B6'] })] }))
    expect(tubes(s.prims, 'wire', 'W1')[0]!.color).toBe('#1f6fb2')
  })

  it('laid wire lifts over a crossing', () => {
    const s = buildScene(mk({
      board: { type: 'two-sided' },
      trails: [trail('T1', ['A3', 'E3'], 'top')],
      wires: [wire({ id: 'W1', points: ['C1', 'C7'] })]
    }))
    const pts = tubes(s.prims, 'wire', 'W1').flatMap(t => t.points)
    const y = (h: string) => yAt(pts, xz(h).x, xz(h).z)
    expect(y('C3')).toBeGreaterThanOrEqual(0.6 + 0.7 - 1e-9)
    expect(y('C5')).toBeCloseTo(0.7)
    expect(y('C1')).toBeCloseTo(0.7)
    // The trail is not lifted.
    for (const q of tubes(s.prims, 'trail')[0]!.points) expect(q[1]).toBeCloseTo(0.3)
  })

  it('a later laid wire lifts over an earlier one, by its diameter', () => {
    const s = buildScene(mk({
      wires: [wire({ id: 'W1', points: ['A3', 'F3'] }), wire({ id: 'W2', points: ['C1', 'C7'] })]
    }))
    const y1 = yAt(tubes(s.prims, 'wire', 'W1').flatMap(t => t.points), xz('C3').x, xz('C3').z)
    const y2 = yAt(tubes(s.prims, 'wire', 'W2').flatMap(t => t.points), xz('C3').x, xz('C3').z)
    expect(y1).toBeCloseTo(0.7)
    expect(y2).toBeGreaterThanOrEqual(1.4 + 0.7 - 1e-9)
  })

  it('flying wire arcs', () => {
    const s = buildScene(mk({ wires: [wire({ id: 'W1', kind: 'flying', points: ['B2', 'H8'] })] }))
    const [t] = tubes(s.prims, 'wire', 'W1')
    expect(t!.points.length).toBeGreaterThanOrEqual(16)
    expect(t!.radius).toBeCloseTo(0.7)
    const maxY = Math.max(...t!.points.map(q => q[1]))
    expect(maxY).toBeGreaterThanOrEqual(3)
    expect(maxY).toBeLessThanOrEqual(15)
    expect(at(t!.points[0]!, 'B2')).toBe(true)
    expect(at(t!.points[t!.points.length - 1]!, 'H8')).toBe(true)
    for (const h of ['B2', 'H8']) expect(coneAt(s.prims, h, -1), h).toBeDefined()
  })

  it('flying wire peak follows the slack, clamped to 3..15', () => {
    const peak = (slack: number) => {
      const s = buildScene(mk({ bench: { endLeadMm: 5, bendAllowanceMm: 1, spareMm: 5, flyingSlackMm: slack, roundToMm: 5, paper: 'letter' }, wires: [wire({ id: 'W1', kind: 'flying', points: ['B2', 'B8'] })] }))
      return Math.max(...tubes(s.prims, 'wire', 'W1')[0]!.points.map(q => q[1]))
    }
    expect(peak(0)).toBeCloseTo(3)
    expect(peak(10)).toBeCloseTo(5)
    expect(peak(100)).toBeCloseTo(15)
  })

  it('flying wire with both ends in one hole is skipped', () => {
    const s = buildScene(mk({ wires: [wire({ id: 'W1', kind: 'flying', points: ['B2', 'B2'] })] }))
    expect(s.prims.filter(p => p.tag.id === 'W1')).toHaveLength(0)
    expect(s.skipped.some(n => n.includes('W1'))).toBe(true)
  })

  it('1-point and zero-length conductors are skipped', () => {
    const s = buildScene(mk({
      trails: [trail('T1', ['B2']), trail('T2', ['C3', 'C3'])],
      wires: [wire({ id: 'W1', points: ['D4', 'D4'] })]
    }))
    for (const id of ['T1', 'T2', 'W1']) {
      expect(s.prims.filter(p => p.tag.id === id), id).toHaveLength(0)
      expect(s.skipped.some(n => n.includes(id)), id).toBe(true)
    }
  })

  it('leg fold and solder bridge', () => {
    const b = board2()
    const s = buildScene(b)
    const folds = tubes(s.prims, 'fold')
    expect(folds).toHaveLength(12)
    for (const f of folds) for (const q of f.points) expect(q[1]).toBeLessThan(-1.6)
    for (const f of b.legFolds) {
      const t = folds.find(x => x.tag.id === f.lead)!
      expect(at(t.points[t.points.length - 1]!, f.to), f.lead).toBe(true)
      expect(coneAt(s.prims, f.to, -1), f.to).toBeDefined()
    }
    expect(s.prims.filter(p => p.tag.kind === 'bridge')).toHaveLength(b.solderBridges.length)

    const one = buildScene(mk({ solderBridges: [{ side: 'bottom', a: 'C3', b: 'C4' }] }))
    const boxes = one.prims.filter(p => p.tag.kind === 'bridge')
    expect(boxes).toHaveLength(1)
    const box = boxes[0]!
    if (box.kind !== 'box') throw new Error('bridge is not a box')
    expect(box.color).toBe('#c8c8c8')
    expect(box.center[0]).toBeCloseTo((xz('C3').x + xz('C4').x) / 2)
    expect(box.center[2]).toBeCloseTo(xz('C3').z)
    expect(box.size[0]).toBeGreaterThanOrEqual(P)
    expect(box.size[1]).toBeLessThan(box.size[2])
    expect(box.center[1]).toBeLessThan(-1.6)
  })

  it('conductor tags carry the net', () => {
    const b = board2()
    const s = buildScene(b)
    const conn = buildConnectivity(b)
    const groupNet = (kind: 'trail' | 'wire', id: string) => {
      const g = conn.groups.find(g => g.conductors.some(c => c.kind === kind && c.id === id))!
      return g.nets.length === 1 ? g.nets[0]! : null
    }
    const ts = tubes(s.prims, 'trail')
    expect(ts.length).toBeGreaterThan(0)
    for (const t of ts) expect(t.tag.net, t.tag.id).toBe(groupNet('trail', t.tag.id))
    expect(ts.some(t => t.tag.net !== null)).toBe(true)
    for (const t of tubes(s.prims, 'wire')) expect(t.tag.net, t.tag.id).toBe(groupNet('wire', t.tag.id))
  })

  it('every cone is unique per hole and side', () => {
    const s = buildScene(board2())
    const keys = cones(s.prims).map(c => `${c.base[0].toFixed(3)},${c.base[2].toFixed(3)},${c.up}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('tags of a shorted group carry all its nets', () => {
    // T1 joins R1.a (GND) and R2.a (V12): one group, shorted.
    const s = buildScene(mk({
      nets: { GND: {}, V12: {} },
      parts: [axial('R1', 'B2', 'E2', 'GND'), axial('R2', 'B6', 'E6', 'V12')],
      trails: [trail('T1', ['B2', 'B6'], 'bottom')]
    }))
    const t = s.prims.find(p => p.tag.kind === 'trail' && p.tag.id === 'T1')!
    expect(t.tag.net).toBeNull()
    expect(t.tag.nets).toEqual(['GND', 'V12'])
    const leg = s.prims.find(p => p.tag.kind === 'leg' && p.tag.id === 'R1.a')!
    expect(leg.tag.net).toBe('GND')
    expect(leg.tag.nets).toEqual(['GND', 'V12'])
    const joint = s.prims.find(p => p.kind === 'cone' && p.tag.id === 'R2.a')!
    expect(joint.tag.nets).toEqual(['GND', 'V12'])
    // A lone leg keeps a one-net group; part bodies carry no nets.
    expect(s.prims.find(p => p.tag.kind === 'leg' && p.tag.id === 'R1.b')!.tag.nets).toEqual([])
    expect(s.prims.find(p => p.tag.kind === 'part')!.tag.nets).toBeUndefined()
  })

  it('bare copper, folds, bridges and joints are metal; insulation is not', () => {
    const s = buildScene(mk({
      wires: [wire({ id: 'W1', points: ['B2', 'B4', 'D4', 'D7'], bareSegments: [0, 2], color: '#ff0000' })],
      trails: [trail('T1', ['F2', 'F6'])],
      solderBridges: [{ side: 'bottom', a: 'H3', b: 'H4' }]
    }))
    const ts = tubes(s.prims, 'wire', 'W1')
    expect(ts.map(t => t.metal === true)).toEqual([true, false, true])
    // The copper ends through the holes are bare too.
    expect(cyls(s.prims).filter(c => c.tag.id === 'W1').every(c => c.metal)).toBe(true)
    expect(tubes(s.prims, 'trail', 'T1')[0]!.metal).toBe(true)
    expect(s.prims.filter(p => p.tag.kind === 'bridge').every(p => p.metal)).toBe(true)
    expect(cones(s.prims).every(c => c.metal)).toBe(true)
    const b2 = buildScene(board2())
    expect(tubes(b2.prims, 'fold').every(t => t.metal)).toBe(true)
    // An insulated flying wire is not metal.
    const fly = buildScene(mk({ wires: [wire({ id: 'W2', kind: 'flying', points: ['B2', 'B8'] })] }))
    expect(tubes(fly.prims, 'wire', 'W2')[0]!.metal).toBeFalsy()
  })

  it('a wire colour that is not a plain colour falls back to the net colour, then blue', () => {
    const bad = 'red;stroke:url(javascript:alert(1))'
    const withNet = buildScene(mk({
      nets: { SIG: { color: '#00aa00' } },
      parts: [axial('R1', 'B2', 'E2', 'SIG')],
      wires: [wire({ id: 'W1', points: ['B2', 'B6'], color: bad })]
    }))
    expect(tubes(withNet.prims, 'wire', 'W1')[0]!.color).toBe('#00aa00')
    const noNet = buildScene(mk({ wires: [wire({ id: 'W1', points: ['B2', 'B6'], color: bad })] }))
    expect(tubes(noNet.prims, 'wire', 'W1')[0]!.color).toBe('#1f6fb2')
    // A bad net colour is not used either.
    const badNet = buildScene(mk({
      nets: { SIG: { color: 'x(1)' } },
      parts: [axial('R1', 'B2', 'E2', 'SIG')],
      wires: [wire({ id: 'W1', points: ['B2', 'B6'], color: bad })]
    }))
    expect(tubes(badNet.prims, 'wire', 'W1')[0]!.color).toBe('#1f6fb2')
    // A plain colour is kept.
    const ok = buildScene(mk({ wires: [wire({ id: 'W1', points: ['B2', 'B6'], color: 'orange' })] }))
    expect(tubes(ok.prims, 'wire', 'W1')[0]!.color).toBe('orange')
  })

  it('odd conductors and a short go through buildScene without breaking it', () => {
    let s: ReturnType<typeof buildScene> | undefined
    expect(() => {
      s = buildScene(mk({
        nets: { GND: {}, V12: {} },
        parts: [axial('R1', 'B2', 'E2', 'GND'), axial('R2', 'B6', 'E6', 'V12')],
        trails: [
          trail('T1', ['B2', 'B6']), // the short: GND to V12
          trail('T2', [])
        ],
        wires: [
          wire({ id: 'W1', kind: 'flying', points: ['G2', 'G2'] }),
          wire({ id: 'W2', points: ['H3', 'H3'] })
        ],
        legFolds: [{ lead: 'R7.a', to: 'J5' }],
        solderBridges: [{ side: 'bottom', a: 'C8', b: 'C8' }]
      }))
    }).not.toThrow()
    const sc = s!
    for (const v of [...sc.bounds.min, ...sc.bounds.max]) expect(Number.isFinite(v)).toBe(true)
    for (const p of sc.prims) {
      const pts = p.kind === 'box' ? [p.center] : p.kind === 'cylinder' ? [p.a, p.b] : p.kind === 'tube' ? p.points : [p.base]
      for (const q of pts) for (const v of q) expect(Number.isFinite(v), `${p.tag.kind} ${p.tag.id}`).toBe(true)
    }
    expect(sc.skipped).toEqual([
      'trail T2: 0 points, skipped',
      'leg fold R7.a: unknown lead, skipped',
      'wire W1: both ends in hole G2, skipped',
      'wire W2: zero length (all points at H3), skipped'
    ])
    // The short is drawn and carries both nets.
    expect(tubes(sc.prims, 'trail', 'T1')[0]!.tag.nets).toEqual(['GND', 'V12'])
    // The self-bridge is a single pad-sized blob.
    const bridge = sc.prims.find(p => p.tag.kind === 'bridge')
    expect(bridge?.kind).toBe('box')
  })
})
