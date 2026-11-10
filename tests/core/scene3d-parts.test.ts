import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseBoard, type BoardFile, type Part } from '~core/schema'
import { bodyHeightMm, placePart, FOOTPRINT_PITCH_MM } from '~core/footprints'
import { holeMm, parseHole } from '~core/holes'
import { buildScene, COLORS, type Prim, type V3 } from '~core/scene3d'
import { mk } from './helpers'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const LEG_BOTTOM = -1.6 - 1.5
/** y of a leg-fold tube's axis: lying on the bottom surface, leg radius 0.3. */
const FOLD_Y = -1.6 - 0.3
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6

/** Every point of a prim, for y extents. */
function ys(p: Prim): number[] {
  switch (p.kind) {
    case 'box': return [p.center[1] - p.size[1] / 2, p.center[1] + p.size[1] / 2]
    case 'cylinder': return [p.a[1], p.b[1]]
    case 'tube': return p.points.map(q => q[1])
    case 'cone': return [p.base[1], p.base[1] + p.up * p.height]
    case 'extrude': return [p.y0, p.y1]
    case 'lathe': return p.profile.map(q => q.y)
  }
}
/** The highest point of a prim, radius included. */
function topOf(p: Prim): number {
  switch (p.kind) {
    case 'box': return p.center[1] + p.size[1] / 2
    case 'cylinder': {
      const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) || 1
      const dy = Math.abs(p.b[1] - p.a[1]) / len
      return Math.max(p.a[1], p.b[1]) + p.radius * Math.sqrt(Math.max(0, 1 - dy * dy))
    }
    case 'tube': return Math.max(...p.points.map(q => q[1])) + p.radius
    case 'cone': return p.up === 1 ? p.base[1] + p.height : p.base[1]
    case 'extrude': return p.y1
    case 'lathe': return Math.max(...p.profile.map(q => q.y))
  }
}
const pointsOf = (p: Prim): V3[] => p.kind === 'cylinder' ? [p.a, p.b] : p.kind === 'tube' ? p.points : []

const pinXZ = (part: Part, pin: string) => {
  const h = placePart(part).pins.find(x => x.name === pin)!.hole
  const m = holeMm(h, FOOTPRINT_PITCH_MM)
  return { x: m.x, z: m.y }
}

describe('scene3d parts', () => {
  const b = board2()
  const s = buildScene(b)
  const bodies = (ref: string) => s.prims.filter(p => p.tag.kind === 'part' && p.tag.id === ref)
  /** The round leg (cylinder or tube) per pin; flat lead boxes share its tag but are not counted. */
  const legs = (ref: string) => s.prims.filter(p => p.tag.kind === 'leg' && p.kind !== 'box' && p.tag.id.split('.')[0] === ref)

  it('every part has a body and one leg per pin', () => {
    expect(s.skipped).toEqual([])
    const folded = new Set(b.legFolds.map(f => f.lead))
    expect(folded.size).toBeGreaterThan(0)
    for (const part of b.parts) {
      expect(bodies(part.ref).length, part.ref).toBeGreaterThanOrEqual(1)
      expect(legs(part.ref), part.ref).toHaveLength(placePart(part).pins.length)
      const bodyBottom = Math.min(...bodies(part.ref).flatMap(ys))
      for (const leg of legs(part.ref)) {
        const pin = leg.tag.id.split('.')[1]!
        const { x, z } = pinXZ(part, pin)
        const pts = pointsOf(leg)
        expect(pts.length, leg.tag.id).toBeGreaterThanOrEqual(2)
        // Lowest point is under the board, at the pin hole. A folded lead ends where its fold
        // tube lies; the fold replaces the cut stub.
        const low = pts.reduce((m, q) => q[1] < m[1] ? q : m)
        expect(low[1], leg.tag.id).toBeCloseTo(folded.has(leg.tag.id) ? FOLD_Y : LEG_BOTTOM)
        expect(low[0]).toBeCloseTo(x)
        expect(low[2]).toBeCloseTo(z)
        // It passes through the hole: a point at the hole's x,z at or above the top surface.
        expect(pts.some(q => close(q[0], x) && close(q[2], z) && q[1] >= 0), leg.tag.id).toBe(true)
        if (leg.kind === 'cylinder') expect(Math.max(leg.a[1], leg.b[1])).toBeLessThanOrEqual(bodyBottom + 1e-9)
        expect(leg.tag.net).toBe(part.pins[pin] ?? null)
      }
      for (const body of bodies(part.ref)) expect(body.tag.net).toBeUndefined()
      // Extra leg prims (flat DIP leads) carry exactly their round leg's tag.
      const round = new Map(legs(part.ref).map(l => [l.tag.id, l.tag]))
      for (const p of s.prims.filter(p => p.tag.kind === 'leg' && p.kind === 'box' && p.tag.id.split('.')[0] === part.ref))
        expect(p.tag, p.tag.id).toEqual(round.get(p.tag.id))
    }
  })

  it('NC pins have legs tagged net null', () => {
    const u1 = legs('U1')
    expect(u1.find(l => l.tag.id === 'U1.1')!.tag.net).toBeNull()
    expect(u1.find(l => l.tag.id === 'U1.2')!.tag.net).toBe('IN_A')
  })

  it('DIP-8 box stands 0.5 off the board with its top at the footprint height', () => {
    const box = bodies('U1').find(p => p.kind === 'box')
    expect(box?.kind).toBe('box')
    if (box?.kind !== 'box') return
    expect(box.size[1]).toBeCloseTo(4.0)
    expect(box.center[1] - box.size[1] / 2).toBeCloseTo(0.5)
    expect(box.center[1] + box.size[1] / 2).toBeCloseTo(4.5)
  })

  it('every part\'s highest body point is its bench-sheet height', () => {
    // Board 2 has every footprint; add a lying diode (its band) and a standing resistor.
    const more: Part[] = [
      { ref: 'D1', footprint: 'axial', at: 'C2', to: 'C6', rotation: 0, value: '1N4148', pins: {} },
      { ref: 'R9', footprint: 'axial', at: 'F2', to: 'F5', rotation: 0, standing: true, pins: {} }
    ]
    const extra = buildScene(mk({ parts: more }))
    const cases = [...b.parts.map(part => ({ part, sc: s })), ...more.map(part => ({ part, sc: extra }))]
    const seen = new Set<string>()
    for (const { part, sc } of cases) {
      const pp = placePart(part)
      seen.add(pp.fp.id)
      const own = sc.prims.filter(p => p.tag.kind === 'part' && p.tag.id === part.ref)
      const top = Math.max(...own.map(topOf))
      expect(Math.abs(top - bodyHeightMm(part, pp.fp)), `${part.ref} top ${top}`).toBeLessThanOrEqual(0.05)
    }
    expect(seen.size).toBe(8)
  })

  it('lying axial is a 2.5 cylinder along the lead axis, body-rect long', () => {
    const part = b.parts.find(p => p.ref === 'RGA')!
    const cyl = bodies('RGA').find(p => p.kind === 'cylinder')
    expect(cyl?.kind).toBe('cylinder')
    if (cyl?.kind !== 'cylinder') return
    expect(cyl.radius * 2).toBeCloseTo(2.5)
    const r = placePart(part).bodyRectMm
    const len = Math.hypot(cyl.b[0] - cyl.a[0], cyl.b[1] - cyl.a[1], cyl.b[2] - cyl.a[2])
    expect(len).toBeCloseTo(Math.max(r.w, r.h))
    const a = pinXZ(part, 'a')
    const bb = pinXZ(part, 'b')
    // Parallel to a -> b and horizontal, resting on the board.
    const ax = [cyl.b[0] - cyl.a[0], cyl.b[2] - cyl.a[2]]
    const lx = [bb.x - a.x, bb.z - a.z]
    expect(ax[0]! * lx[1]! - ax[1]! * lx[0]!).toBeCloseTo(0)
    expect(cyl.a[1]).toBeCloseTo(1.25)
    expect(cyl.b[1]).toBeCloseTo(1.25)
  })

  it('standing axial is a vertical 7 mm cylinder over lead a', () => {
    const part = b.parts.find(p => p.ref === 'RPA')!
    const cyl = bodies('RPA').find(p => p.kind === 'cylinder')
    expect(cyl?.kind).toBe('cylinder')
    if (cyl?.kind !== 'cylinder') return
    const a = pinXZ(part, 'a')
    for (const q of [cyl.a, cyl.b]) {
      expect(q[0]).toBeCloseTo(a.x)
      expect(q[2]).toBeCloseTo(a.z)
    }
    expect(Math.min(cyl.a[1], cyl.b[1])).toBeCloseTo(0)
    expect(Math.abs(cyl.b[1] - cyl.a[1])).toBeCloseTo(7)
    // Lead b loops over the top.
    const lb = legs('RPA').find(l => l.tag.id === 'RPA.b')!
    expect(lb.kind).toBe('tube')
    expect(Math.max(...ys(lb))).toBeGreaterThan(7)
  })

  it('every leg is soldered underneath', () => {
    const cones = s.prims.filter(p => p.kind === 'cone' && p.tag.kind === 'joint')
    for (const part of b.parts)
      for (const pin of placePart(part).pins) {
        const m = holeMm(pin.hole, FOOTPRINT_PITCH_MM)
        const at = cones.filter(c => c.kind === 'cone' && c.up === -1 && close(c.base[0], m.x) && close(c.base[2], m.y))
        expect(at, `${part.ref}.${pin.name}`).toHaveLength(1)
        const c = at[0]!
        if (c.kind !== 'cone') continue
        expect(c.base[1]).toBeCloseTo(-1.6)
        expect(c.radius * 2).toBeCloseTo(1.8)
        expect(c.height).toBeCloseTo(0.9)
        // The kept cone names the leg it solders.
        expect(c.tag.label, c.tag.id).toBe(`${c.tag.id.replace('.', ' pin ')} joint`)
      }
    expect(cones.find(c => c.tag.id === 'U1.1')!.tag.label).toBe('U1 pin 1 joint')
  })

  it('metal parts are marked metal, moulded bodies are not', () => {
    const metal = (p: Prim) => p.metal === true
    // Header posts (body boxes and the leg tails), the TO-220 tab, legs and joints.
    expect(bodies('JH').filter(p => p.color === COLORS.headerPin).every(metal)).toBe(true)
    expect(legs('JH').every(metal)).toBe(true)
    expect(bodies('QA').filter(p => p.color === COLORS.tab).every(metal)).toBe(true)
    expect(bodies('QA').filter(p => p.color === COLORS.tab).length).toBe(1)
    expect(s.prims.filter(p => p.tag.kind === 'leg').every(metal)).toBe(true)
    expect(s.prims.filter(p => p.tag.kind === 'joint').every(metal)).toBe(true)
    // Moulded and printed parts are not.
    for (const c of [COLORS.black, COLORS.relay, COLORS.terminal, COLORS.tabHole, COLORS.resistor, COLORS.capDisc])
      expect(s.prims.filter(p => p.tag.kind === 'part' && p.color === c).some(metal), c).toBe(false)
  })

  it('one solder cone per hole and side', () => {
    // Two parts sharing a hole: still one cone there.
    const s2 = buildScene(mk({
      parts: [
        { ref: 'R1', footprint: 'axial', at: 'A1', to: 'A4', rotation: 0, pins: { a: 'N1', b: 'N2' } },
        { ref: 'R2', footprint: 'axial', at: 'A4', to: 'A7', rotation: 0, pins: { a: 'N2', b: 'N3' } }
      ]
    }))
    const m = holeMm(parseHole('A4'), FOOTPRINT_PITCH_MM)
    const cones = s2.prims.filter(p => p.kind === 'cone' && close(p.base[0], m.x) && close(p.base[2], m.y))
    expect(cones).toHaveLength(1)
  })

  it('unknown footprint is skipped and reported', () => {
    const raw = JSON.parse(JSON.stringify(b)) as BoardFile
    raw.parts.push({ ref: 'X1', footprint: 'nope', at: 'A1', rotation: 0, pins: {} })
    const s3 = buildScene(raw)
    expect(s3.prims.filter(p => p.tag.id.split('.')[0] === 'X1')).toEqual([])
    expect(s3.skipped).toHaveLength(1)
    expect(s3.skipped[0]).toContain('X1')
    expect(s3.skipped[0]).toContain('nope')
    expect(bodies('U1').length).toBeGreaterThan(0)
    expect(s3.prims.filter(p => p.tag.kind === 'part' && p.tag.id === 'U1').length).toBeGreaterThan(0)
  })

  it('bounds cover the legs and the tallest part', () => {
    expect(s.bounds.min[1]).toBeLessThanOrEqual(LEG_BOTTOM + 1e-9)
    expect(s.bounds.max[1]).toBeGreaterThanOrEqual(15.5)
  })

  it('non-two-lead body boxes cover exactly the 2D body rect in x/z', () => {
    for (const part of b.parts) {
      const pp = placePart(part)
      if (pp.fp.twoLead) continue
      // Every box, the TO-220 tab plate included: it is the back face of the body rect.
      const boxes = bodies(part.ref).filter(p => p.kind === 'box')
      expect(boxes.length, part.ref).toBeGreaterThan(0)
      const ext = boxes.flatMap((p) => {
        if (p.kind !== 'box') return []
        return [[p.center[0] - p.size[0] / 2, p.center[0] + p.size[0] / 2, p.center[2] - p.size[2] / 2, p.center[2] + p.size[2] / 2]]
      })
      const r = pp.bodyRectMm
      const got = [Math.min(...ext.map(e => e[0]!)), Math.max(...ext.map(e => e[1]!)), Math.min(...ext.map(e => e[2]!)), Math.max(...ext.map(e => e[3]!))]
      const want = [r.x, r.x + r.w, r.y, r.y + r.h]
      got.forEach((g, i) => expect(Math.abs(g - want[i]!), `${part.ref} edge ${i}`).toBeLessThan(0.05))
    }
  })

  it('header has a gold post per pin', () => {
    const part = b.parts.find(p => p.ref === 'JH')!
    const pp = placePart(part)
    const posts = bodies('JH').filter(p => p.kind === 'box' && p.color === '#d4af37')
    expect(posts).toHaveLength(pp.pins.length)
    const black = bodies('JH').filter((p): p is Extract<Prim, { kind: 'box' }> => p.kind === 'box' && p.color === COLORS.black)
    // The bar is two boxes: the full bar and a narrower chamfered top.
    expect(black).toHaveLength(2)
    const [lo, hi] = [...black].sort((p, q) => p.center[1] - q.center[1])
    expect(hi!.size[0] * hi!.size[2]).toBeLessThan(lo!.size[0] * lo!.size[2])
    const barTop = hi!.center[1] + hi!.size[1] / 2
    expect(barTop).toBeCloseTo(2.5)
    for (const pin of pp.pins) {
      const { x, z } = pinXZ(part, pin.name)
      const post = posts.find(p => p.kind === 'box' && close(p.center[0], x) && close(p.center[2], z))
      expect(post?.kind, pin.name).toBe('box')
      if (post?.kind !== 'box') continue
      expect(post.size[0]).toBeCloseTo(0.64)
      expect(post.size[2]).toBeCloseTo(0.64)
      expect(post.center[1] - post.size[1] / 2).toBeCloseTo(barTop)
      expect(post.size[1]).toBeCloseTo(6)
      // The post's tail under the board is the gold leg.
      const leg = legs('JH').find(l => l.tag.id === `JH.${pin.name}`)!
      expect(leg.color).toBe('#d4af37')
    }
    // A pin-1 triangle on top of the bar, outboard of pin 1.
    const marks = bodies('JH').filter(p => p.kind === 'box' && p.color === COLORS.markLight)
    expect(marks.length).toBeGreaterThanOrEqual(2)
    const p1 = pinXZ(part, '1')
    const p2 = pinXZ(part, '2')
    for (const m of marks) {
      if (m.kind !== 'box') continue
      expect(Math.hypot(m.center[0] - p1.x, m.center[2] - p1.z)).toBeLessThan(Math.hypot(m.center[0] - p2.x, m.center[2] - p2.z))
      expect(m.center[1] - m.size[1] / 2).toBeGreaterThanOrEqual(barTop - 1e-9)
    }
  })

  it('terminal block has a screw per position on top', () => {
    for (const ref of ['JA', 'JB', 'J3']) {
      const part = b.parts.find(p => p.ref === ref)!
      const pp = placePart(part)
      const top = Math.max(...bodies(ref).filter(p => p.color === COLORS.terminal).flatMap(ys))
      expect(top, ref).toBeCloseTo(10)
      for (const pin of pp.pins) {
        const { x, z } = pinXZ(part, pin.name)
        const screw = bodies(ref).find(p => p.kind === 'cylinder' && p.color === COLORS.screw
          && close(p.a[0], x) && close(p.a[2], z) && close(p.b[0], x) && close(p.b[2], z))
        expect(screw?.kind, `${ref}.${pin.name}`).toBe('cylinder')
        if (screw?.kind !== 'cylinder') continue
        expect(Math.max(screw.a[1], screw.b[1])).toBeGreaterThan(top)
        // A dark slot across the head, and a wire entry on the side the pins are nearer.
        const slot = bodies(ref).find(p => p.kind === 'box' && p.color === COLORS.slot
          && Math.hypot(p.center[0] - x, p.center[2] - z) < 0.01)
        expect(slot?.kind, `${ref}.${pin.name} slot`).toBe('box')
        const entry = bodies(ref).filter(p => p.kind === 'box' && p.color === COLORS.wireEntry && close(p.center[0], x))
        expect(entry, `${ref}.${pin.name} entry`).toHaveLength(1)
        const e = entry[0]!
        if (e.kind !== 'box') continue
        const r = pp.bodyRectMm
        // Row A parts: the wire side faces the board's top edge (low z).
        expect(e.center[2]).toBeLessThan(r.y + 0.5)
      }
    }
  })

  it('TO-220 tab has its mounting hole on the tab side', () => {
    for (const ref of ['QA', 'QB']) {
      const part = b.parts.find(p => p.ref === ref)!
      const r = placePart(part).bodyRectMm
      const body = bodies(ref).find((p): p is Extract<Prim, { kind: 'box' }> => p.kind === 'box' && p.color === COLORS.black)!
      const tab = bodies(ref).find((p): p is Extract<Prim, { kind: 'box' }> => p.kind === 'box' && p.color === COLORS.tab)!
      const hole = bodies(ref).find((p): p is Extract<Prim, { kind: 'cylinder' }> => p.kind === 'cylinder' && p.color === COLORS.tabHole)
      expect(hole?.kind, ref).toBe('cylinder')
      if (!hole) continue
      expect(hole.radius * 2).toBeCloseTo(3.6)
      const c = hole.a.map((v, i) => (v + hole.b[i]!) / 2) as V3
      // Centred on the tab plate, above the body.
      expect(c[0]).toBeCloseTo(tab.center[0])
      expect(c[2]).toBeCloseTo(tab.center[2])
      const bodyTop = body.center[1] + body.size[1] / 2
      const tabTop = tab.center[1] + tab.size[1] / 2
      expect(c[1] - hole.radius).toBeGreaterThan(bodyTop)
      expect(c[1] + hole.radius).toBeLessThan(tabTop)
      // The plate is the body's back face on the tab side: inside the 2D rect, flush with
      // its tab-side edge, 1.3 thick, and past the pins along the tab direction.
      const n = placePart(part).tab!
      const back = n.dx > 0 ? r.x + r.w : n.dx < 0 ? r.x : n.dy > 0 ? r.y + r.h : r.y
      const k = n.dx !== 0 ? 0 : 2
      const s2 = n.dx !== 0 ? n.dx : n.dy
      expect(tab.center[k] + s2 * tab.size[k] / 2, ref).toBeCloseTo(back)
      expect(tab.size[k]).toBeCloseTo(1.3)
      const pin = pinXZ(part, 'D')
      expect(s2 * (c[k] - (k === 0 ? pin.x : pin.z)), ref).toBeGreaterThan(0)
      // The plate does not cover the pins.
      expect(s2 * (tab.center[k] - s2 * tab.size[k] / 2 - (k === 0 ? pin.x : pin.z)), ref).toBeGreaterThan(0)
      const thin = tab.size[0] < tab.size[2] ? 0 : 2
      expect(Math.abs(hole.b[thin] - hole.a[thin])).toBeGreaterThanOrEqual(tab.size[thin] - 1e-9)
      expect(Math.abs(hole.b[2 - thin] - hole.a[2 - thin])).toBeCloseTo(0)
    }
  })

  it('TO-220 legs are straight; body top = heightMm', () => {
    for (const ref of ['QA', 'QB']) {
      const part = b.parts.find(p => p.ref === ref)!
      const pp = placePart(part)
      const own = bodies(ref)
      // The body and tab stand on the board; the tab reaches the footprint height (15.5).
      expect(Math.min(...own.flatMap(ys)), ref).toBeCloseTo(0)
      expect(Math.max(...own.map(topOf)), ref).toBeCloseTo(pp.fp.body.heightMm)
      expect(pp.fp.body.heightMm).toBe(15.5)
      for (const leg of legs(ref)) {
        const { x, z } = pinXZ(part, leg.tag.id.split('.')[1]!)
        // Vertical at its hole, from the body bottom down through the board: no kink.
        for (const q of pointsOf(leg)) {
          expect(q[0], leg.tag.id).toBeCloseTo(x)
          expect(q[2], leg.tag.id).toBeCloseTo(z)
        }
        expect(Math.max(...ys(leg)), leg.tag.id).toBeCloseTo(0)
        expect(Math.min(...ys(leg)), leg.tag.id).toBeCloseTo(LEG_BOTTOM)
        // Under the body (straight-mounted): the hole is inside the 2D body rect.
        const r = pp.bodyRectMm
        expect(x > r.x && x < r.x + r.w && z > r.y && z < r.y + r.h, leg.tag.id).toBe(true)
      }
    }
  })

  for (const rotation of [0, 90] as const) {
    it(`DIP-8 pin-1 notch is at pin 1 after rotation ${rotation}`, () => {
      const part: Part = { ref: 'U9', footprint: 'dip8', at: 'D5', rotation, pins: {} }
      const sc = buildScene(mk({ parts: [part] }))
      const own = sc.prims.filter(p => p.tag.kind === 'part' && p.tag.id === 'U9')
      const marks = own.filter(p => p.color === COLORS.markDark)
      const notch = marks.find(p => p.kind === 'box')
      const dot = marks.find(p => p.kind === 'cylinder')
      expect(notch?.kind).toBe('box')
      expect(dot?.kind).toBe('cylinder')
      if (notch?.kind !== 'box' || dot?.kind !== 'cylinder') return
      const at = (n: string) => pinXZ(part, n)
      const mid = (p: string, q: string) => ({ x: (at(p).x + at(q).x) / 2, z: (at(p).z + at(q).z) / 2 })
      const d = (c: { x: number, z: number }, x: number, z: number) => Math.hypot(c.x - x, c.z - z)
      // The notch is on the pin-1 end (pins 1 and 8), the dot nearest pin 1.
      expect(d(mid('1', '8'), notch.center[0], notch.center[2])).toBeLessThan(d(mid('4', '5'), notch.center[0], notch.center[2]))
      expect(d(mid('1', '8'), notch.center[0], notch.center[2])).toBeLessThan(2)
      const near = placePart(part).pins.map(p => ({ n: p.name, d: d(at(p.name), dot.a[0], dot.a[2]) })).sort((p, q) => p.d - q.d)
      expect(near[0]!.n).toBe('1')
      // Flat leads: 0.5 x 0.25 boxes tagged as the pin's leg.
      const flat = sc.prims.filter(p => p.tag.kind === 'leg' && p.kind === 'box' && p.tag.id === 'U9.1')
      expect(flat.length).toBeGreaterThanOrEqual(2)
      for (const f of flat) {
        if (f.kind !== 'box') continue
        expect([...f.size].sort((p, q) => p - q).slice(0, 2).map(v => +v.toFixed(3))).toEqual([0.25, 0.5])
      }
    })
  }

  it('relay has a pin-1 mark on top', () => {
    const part = b.parts.find(p => p.ref === 'KA')!
    const mark = bodies('KA').find(p => p.color === COLORS.markLight)
    expect(mark?.kind).toBe('cylinder')
    if (mark?.kind !== 'cylinder') return
    expect(Math.min(mark.a[1], mark.b[1])).toBeGreaterThanOrEqual(11.5 - 1e-9)
    const near = placePart(part).pins.map(p => ({ n: p.name, d: Math.hypot(pinXZ(part, p.name).x - mark.a[0], pinXZ(part, p.name).z - mark.a[2]) }))
      .sort((p, q) => p.d - q.d)
    expect(near[0]!.n).toBe('1')
  })

  it('diode band sits at lead b', () => {
    // Lying, with a value the old word-boundary regex missed.
    const lying: Part = { ref: 'D1', footprint: 'axial', at: 'C2', to: 'C6', rotation: 0, value: 'D1N4148', pins: {} }
    const sc = buildScene(mk({ parts: [lying] }))
    const band = sc.prims.find(p => p.tag.id === 'D1' && p.color === COLORS.diodeStripe)
    expect(band?.kind).toBe('cylinder')
    if (band?.kind !== 'cylinder') return
    const a = pinXZ(lying, 'a')
    const bb = pinXZ(lying, 'b')
    const L = 6.3
    const u = { x: (bb.x - a.x) / Math.hypot(bb.x - a.x, bb.z - a.z), z: (bb.z - a.z) / Math.hypot(bb.x - a.x, bb.z - a.z) }
    const m = { x: (a.x + bb.x) / 2, z: (a.z + bb.z) / 2 }
    const proj = (((band.a[0] + band.b[0]) / 2 - m.x) * u.x + ((band.a[2] + band.b[2]) / 2 - m.z) * u.z)
    expect(proj).toBeGreaterThan(0.35 * L)
    expect(proj).toBeLessThan(L / 2)
    // Standing: lead b leaves the top, so the band is at the top end.
    const da1 = bodies('DA1').find(p => p.color === COLORS.diodeStripe)
    expect(da1?.kind).toBe('cylinder')
    if (da1?.kind !== 'cylinder') return
    expect(Math.min(da1.a[1], da1.b[1])).toBeGreaterThan(7 * 0.75)
  })

  it('standing lead b hairpins over the top and runs down beside the body', () => {
    for (const ref of ['RPA', 'DA1']) {
      const part = b.parts.find(p => p.ref === ref)!
      const a = pinXZ(part, 'a')
      const bb = pinXZ(part, 'b')
      const lb = legs(ref).find(l => l.tag.id === `${ref}.b`)!
      if (lb.kind !== 'tube') throw new Error('tube')
      // More than a flat bridge: an arc of several points above the top.
      expect(lb.points.filter(q => q[1] > 7).length).toBeGreaterThanOrEqual(3)
      // Every point outside the body's radius is clear of it.
      for (const q of lb.points) {
        const r = Math.hypot(q[0] - a.x, q[2] - a.z)
        if (q[1] < 7) expect(r, `${ref} ${q.join(',')}`).toBeGreaterThan(1.25 + 0.3)
      }
      // The run down the side is at lead b, above the board.
      expect(lb.points.some(q => close(q[0], bb.x) && close(q[2], bb.z) && q[1] >= 7)).toBe(true)
    }
  })
})
