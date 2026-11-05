// Logic ported from perfwire solver.py erc_audit (open-net union-find), Apache-2.0
//
// Side-aware conductor graph. Nodes are leads, trails, wires and pads; a pad is the
// solder on one side of one hole. The two sides of a hole are never joined by the
// board itself (two-sided boards are unplated): only something going through the
// hole (a lead or a wire end) joins them, and only where that side has solder.
//
// Contact rule (spec §9b): a bare conductor (a trail, or a bare segment of a laid
// wire) on side S that passes over a hole touches whatever is there on side S: a
// lead or wire end in the hole, solder on that pad, or another bare conductor.
import { holeKey, parseHole, straightRun, type Hole } from './holes'
import { placePart } from './footprints'
import type { BoardFile, Side } from './schema'

export type Conductor =
  | { kind: 'lead'; id: string }
  | { kind: 'trail'; id: string }
  | { kind: 'wire'; id: string }
  | { kind: 'pad'; hole: Hole; side: Side }

export interface Connectivity {
  /** Electrically joined sets. `nets` and `leads` are sorted. */
  groups: { conductors: Conductor[]; nets: string[]; leads: string[] }[]
  groupOfLead: Map<string, number>
  /**
   * A bare conductor touching something at a hole where it has no joint. `trailId` is the
   * trail (or laid wire, for a bare segment) that passes over; `with` is the lead id, wire id,
   * trail id, or the source of the solder it touches. `sameNet` is true when the final
   * group (after every contact) carries at most one net; a shorted group makes every contact in it false.
   */
  contacts: { hole: Hole; side: Side; trailId: string; with: string; sameNet: boolean }[]
  /** Joints the contact rule needs that the trail doesn't list yet (same-net contacts). */
  proposedJoints: { trailId: string; hole: Hole }[]
  /** The single net at that hole on that side; null when none or when it is shorted. */
  netAtHole(h: Hole, side: Side): string | null
}

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let r = x
    while (this.parent.get(r) !== r) r = this.parent.get(r)!
    while (this.parent.get(x) !== r) {
      const next = this.parent.get(x)!
      this.parent.set(x, r)
      x = next
    }
    return r
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

const leadNode = (id: string) => `lead:${id}`
const trailNode = (id: string) => `trail:${id}`
const wireNode = (id: string) => `wire:${id}`
const padNode = (h: Hole, side: Side) => `pad:${holeKey(h)}:${side}`

/** Every hole on a polyline, bend points included, without repeats. */
function pathHoles(points: Hole[], segments?: number[]): Hole[] {
  if (points.length === 1 && !segments) return [points[0]!]
  const seen = new Map<string, Hole>()
  for (let i = 0; i + 1 < points.length; i++) {
    if (segments && !segments.includes(i)) continue
    for (const h of straightRun(points[i]!, points[i + 1]!)) seen.set(holeKey(h), h)
  }
  return [...seen.values()]
}

interface Bare { node: string; id: string; side: Side; holes: Hole[]; joined: Set<string> }

export function buildConnectivity(board: BoardFile): Connectivity {
  const twoSided = board.board.type === 'two-sided'
  const uf = new UnionFind()
  const order: string[] = [] // node insertion order, for stable group numbering
  const conductorOf = new Map<string, Conductor>()
  const add = (node: string, c: Conductor) => {
    if (!conductorOf.has(node)) {
      conductorOf.set(node, c)
      order.push(node)
      uf.find(node)
    }
    return node
  }

  // ---- What sits in each hole -------------------------------------------------
  const leadNet = new Map<string, string | null>()
  const leadsAt = new Map<string, string[]>() // hole key -> lead ids
  const leadHole = new Map<string, Hole>()
  for (const part of board.parts) {
    for (const pin of placePart(part).pins) {
      const id = `${part.ref}.${pin.name}`
      leadNet.set(id, pin.net)
      leadHole.set(id, pin.hole)
      const k = holeKey(pin.hole)
      leadsAt.set(k, [...(leadsAt.get(k) ?? []), id])
      add(leadNode(id), { kind: 'lead', id })
    }
  }

  const wireEnds = new Map<string, string[]>() // hole key -> wire ids
  const wirePts = new Map<string, Hole[]>()
  for (const w of board.wires) {
    const pts = w.points.map(parseHole)
    wirePts.set(w.id, pts)
    add(wireNode(w.id), { kind: 'wire', id: w.id })
    for (const end of [pts[0]!, pts[pts.length - 1]!]) {
      const k = holeKey(end)
      const list = wireEnds.get(k) ?? []
      if (!list.includes(w.id)) list.push(w.id)
      wireEnds.set(k, list)
    }
  }

  // ---- Which pads carry solder, and who put it there ---------------------------
  const solder = new Map<string, { hole: Hole; side: Side; by: string[] }>()
  const addSolder = (h: Hole, side: Side, by: string) => {
    if (side === 'top' && !twoSided) return // one-sided boards have no top pads
    const node = padNode(h, side)
    const s = solder.get(node) ?? { hole: h, side, by: [] }
    if (!s.by.includes(by)) s.by.push(by)
    solder.set(node, s)
  }
  const hasPad = (h: Hole, side: Side) => solder.has(padNode(h, side))

  for (const [id, h] of leadHole) addSolder(h, 'bottom', id)
  for (const [id, pts] of wirePts) {
    addSolder(pts[0]!, 'bottom', id)
    addSolder(pts[pts.length - 1]!, 'bottom', id)
  }
  for (const w of board.wires) for (const j of w.joints) addSolder(parseHole(j), w.side, w.id)
  const trailPts = new Map<string, Hole[]>()
  for (const t of board.trails) {
    const pts = t.points.map(parseHole)
    trailPts.set(t.id, pts)
    add(trailNode(t.id), { kind: 'trail', id: t.id })
    if (pts.length) {
      addSolder(pts[0]!, t.side, t.id)
      addSolder(pts[pts.length - 1]!, t.side, t.id)
    }
    for (const j of t.joints) addSolder(parseHole(j), t.side, t.id)
  }
  for (const b of board.solderBridges) {
    addSolder(parseHole(b.a), b.side, 'solder bridge')
    addSolder(parseHole(b.b), b.side, 'solder bridge')
  }
  for (const f of board.legFolds) addSolder(parseHole(f.to), 'bottom', f.lead)
  for (const [node, s] of solder) add(node, { kind: 'pad', hole: s.hole, side: s.side })

  // ---- Explicit joins ------------------------------------------------------------
  // Through-hole items (leads, wire ends) join the bottom pad always and the top pad
  // when the top side is soldered there.
  const throughHole = (node: string, h: Hole) => {
    for (const side of ['bottom', 'top'] as const) if (hasPad(h, side)) uf.union(node, padNode(h, side))
  }
  for (const [id, h] of leadHole) throughHole(leadNode(id), h)
  for (const [id, pts] of wirePts) {
    throughHole(wireNode(id), pts[0]!)
    throughHole(wireNode(id), pts[pts.length - 1]!)
  }

  const bare: Bare[] = []
  for (const t of board.trails) {
    const pts = trailPts.get(t.id)!
    const joined = new Set<string>()
    const join = (h: Hole) => {
      if (!hasPad(h, t.side)) return
      uf.union(trailNode(t.id), padNode(h, t.side))
      joined.add(holeKey(h))
    }
    if (pts.length) {
      join(pts[0]!)
      join(pts[pts.length - 1]!)
    }
    for (const j of t.joints) join(parseHole(j))
    if (pts.length) bare.push({ node: trailNode(t.id), id: t.id, side: t.side, holes: pathHoles(pts), joined })
  }
  for (const w of board.wires) {
    const pts = wirePts.get(w.id)!
    const joined = new Set<string>([holeKey(pts[0]!), holeKey(pts[pts.length - 1]!)])
    for (const j of w.joints) {
      const h = parseHole(j)
      if (!hasPad(h, w.side)) continue
      uf.union(wireNode(w.id), padNode(h, w.side))
      joined.add(holeKey(h))
    }
    if (w.kind === 'laid' && w.bareSegments.length)
      bare.push({ node: wireNode(w.id), id: w.id, side: w.side, holes: pathHoles(pts, w.bareSegments), joined })
  }

  for (const b of board.solderBridges) {
    const a = parseHole(b.a)
    const c = parseHole(b.b)
    if (hasPad(a, b.side) && hasPad(c, b.side)) uf.union(padNode(a, b.side), padNode(c, b.side))
  }
  for (const f of board.legFolds) {
    if (!leadNet.has(f.lead)) continue // unknown lead: reported by the check, not here
    uf.union(leadNode(f.lead), padNode(parseHole(f.to), 'bottom'))
  }

  // ---- Contact rule --------------------------------------------------------------
  const bareAt = new Map<string, Bare[]>() // "key|side" -> bare conductors over that hole
  for (const c of bare)
    for (const h of c.holes) {
      const k = `${holeKey(h)}|${c.side}`
      bareAt.set(k, [...(bareAt.get(k) ?? []), c])
    }

  // Contacts are collected first and judged after every contact union, so a short made
  // through contacts (or a chain of them) is never called same-net.
  const found: { hole: Hole; side: Side; trailId: string; with: string; node: string }[] = []
  for (const c of bare) {
    for (const h of c.holes) {
      const k = holeKey(h)
      if (c.joined.has(k)) continue
      const touched: { node: string; with: string }[] = []
      for (const id of leadsAt.get(k) ?? []) touched.push({ node: leadNode(id), with: id })
      for (const id of wireEnds.get(k) ?? []) if (wireNode(id) !== c.node) touched.push({ node: wireNode(id), with: id })
      const pad = solder.get(padNode(h, c.side))
      if (pad && !touched.length) {
        const by = pad.by.find(x => x !== c.id) ?? pad.by[0]!
        touched.push({ node: padNode(h, c.side), with: by })
      }
      for (const o of bareAt.get(`${k}|${c.side}`) ?? [])
        if (o !== c && !touched.some(t => t.with === o.id)) touched.push({ node: o.node, with: o.id })
      for (const t of touched) {
        found.push({ hole: h, side: c.side, trailId: c.id, with: t.with, node: c.node })
        uf.union(c.node, t.node)
      }
    }
  }

  // Nets of each final group (after contacts).
  const netsByRoot = new Map<string, Set<string>>()
  for (const [id, net] of leadNet) {
    if (net === null) continue
    const r = uf.find(leadNode(id))
    const s = netsByRoot.get(r) ?? new Set<string>()
    s.add(net)
    netsByRoot.set(r, s)
  }

  const contacts: Connectivity['contacts'] = []
  const proposedJoints: Connectivity['proposedJoints'] = []
  const proposedKeys = new Set<string>()
  for (const f of found) {
    const sameNet = (netsByRoot.get(uf.find(f.node))?.size ?? 0) <= 1
    contacts.push({ hole: f.hole, side: f.side, trailId: f.trailId, with: f.with, sameNet })
    const pk = `${f.trailId}|${holeKey(f.hole)}`
    if (sameNet && !proposedKeys.has(pk)) {
      proposedKeys.add(pk)
      proposedJoints.push({ trailId: f.trailId, hole: f.hole })
    }
  }

  // ---- Groups --------------------------------------------------------------------
  const groupIndex = new Map<string, number>()
  const groups: Connectivity['groups'] = []
  const groupOfNode = (node: string) => groupIndex.get(uf.find(node))!
  for (const node of order) {
    const r = uf.find(node)
    let gi = groupIndex.get(r)
    if (gi === undefined) {
      gi = groups.length
      groupIndex.set(r, gi)
      groups.push({ conductors: [], nets: [], leads: [] })
    }
    const g = groups[gi]!
    const cond = conductorOf.get(node)!
    g.conductors.push(cond)
    if (cond.kind === 'lead') {
      g.leads.push(cond.id)
      const net = leadNet.get(cond.id)
      if (net != null && !g.nets.includes(net)) g.nets.push(net)
    }
  }
  for (const g of groups) {
    g.nets.sort()
    g.leads.sort()
  }
  const groupOfLead = new Map<string, number>()
  for (const id of leadNet.keys()) groupOfLead.set(id, groupOfNode(leadNode(id)))

  // ---- netAtHole -----------------------------------------------------------------
  // Most specific first: the pad on that side, then what goes through the hole, then
  // conductors lying over it on that side (laid wires count along their whole path).
  const overAt = new Map<string, string[]>() // "key|side" -> trail/wire nodes over that hole
  const addOver = (h: Hole, side: Side, node: string) => {
    const k = `${holeKey(h)}|${side}`
    overAt.set(k, [...(overAt.get(k) ?? []), node])
  }
  for (const t of board.trails) {
    const pts = trailPts.get(t.id)!
    if (pts.length) for (const h of pathHoles(pts)) addOver(h, t.side, trailNode(t.id))
  }
  for (const w of board.wires)
    if (w.kind === 'laid') for (const h of pathHoles(wirePts.get(w.id)!)) addOver(h, w.side, wireNode(w.id))

  const netAtHole = (h: Hole, side: Side): string | null => {
    const k = holeKey(h)
    const tiers: string[][] = [
      hasPad(h, side) ? [padNode(h, side)] : [],
      [...(leadsAt.get(k) ?? []).map(leadNode), ...(wireEnds.get(k) ?? []).map(wireNode)],
      overAt.get(`${k}|${side}`) ?? []
    ]
    const tier = tiers.find(t => t.length)
    if (!tier) return null
    const nets = new Set(tier.flatMap(node => groups[groupOfNode(node)]!.nets))
    for (const node of tier) if (groups[groupOfNode(node)]!.nets.length > 1) return null
    return nets.size === 1 ? [...nets][0]! : null
  }

  return { groups, groupOfLead, contacts, proposedJoints, netAtHole }
}
