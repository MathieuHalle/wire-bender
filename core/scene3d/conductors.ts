// Conductors in the 3D scene: bare trails, laid and flying wires, their solder joints,
// leg folds and solder bridges. Pure: no Node, DOM or three.js.
import { buildConnectivity } from '../connectivity'
import { FOOTPRINT_PITCH_MM, placePart } from '../footprints'
import { holeKey, holeMm, holeName, parseHole, straightRun, walkHoles, type Hole } from '../holes'
import type { BoardFile, Side } from '../schema'
import {
  BARE_WIRE_DIAMETER_MM, BOARD_BOTTOM_Y, COLORS, INSULATED_WIRE_DIAMETER_MM, LEG_DIAMETER_MM,
  SOLDER_BASE_DIAMETER_MM, SOLDER_HEIGHT_MM
} from './dims'
import type { Prim, Tag, V3, XZ } from './types'

const BARE_R = BARE_WIRE_DIAMETER_MM / 2
const INS_R = INSULATED_WIRE_DIAMETER_MM / 2
const LEG_R = LEG_DIAMETER_MM / 2
/** Where a through-hole conductor end stops: inside its solder cone under the board. */
const THROUGH_END_Y = BOARD_BOTTOM_Y - SOLDER_HEIGHT_MM / 2
/** Odd, so the peak itself is a point. */
const FLYING_POINTS = 25
const BRIDGE_WIDTH_MM = 1.0
const BRIDGE_HEIGHT_MM = 0.4

/**
 * y of a conductor's centre lying `lift` mm off the surface of `side` with radius r.
 * Top: up from y = 0. Bottom: down from the bottom surface.
 */
const lyingY = (side: Side, r: number, lift = 0) => side === 'top' ? r + lift : BOARD_BOTTOM_Y - r - lift

/** Drop consecutive repeats. */
function dedupPoints(pts: Hole[]): Hole[] {
  return pts.filter((h, i) => i === 0 || holeKey(h) !== holeKey(pts[i - 1]!))
}

/** Something lying over a hole on one side: how far its top stands off the surface, and its half-width. */
interface Occupant { owner: string, top: number, halfW: number }

export function conductorPrims(board: BoardFile, skipped: string[]): Prim[] {
  const pitch = board.board.pitchMm
  const oneSided = board.board.type === 'one-sided'
  // Parts that cannot be placed are skipped (and reported) by buildScene; leave them out here too.
  const placeable = board.parts.filter((p) => {
    try {
      placePart(p)
      return true
    } catch {
      return false
    }
  })
  const conn = buildConnectivity(placeable.length === board.parts.length ? board : { ...board, parts: placeable })
  const out: Prim[] = []

  const pos = (h: Hole, p = pitch): XZ => {
    const m = holeMm(h, p)
    return { x: m.x, z: m.y }
  }
  const groupNet = (gi: number | null | undefined): string | null => {
    const g = gi == null ? undefined : conn.groups[gi]
    return g && g.nets.length === 1 ? g.nets[0]! : null
  }
  const conductorNet = (kind: 'trail' | 'wire', id: string) =>
    groupNet(conn.groups.findIndex(g => g.conductors.some(c => c.kind === kind && c.id === id)))
  const netColor = (net: string | null): string | undefined => {
    if (!net) return undefined
    const cls = board.nets[net]?.class
    return board.nets[net]?.color ?? (cls ? board.netClasses[cls]?.color : undefined)
  }

  const cone = (q: XZ, up: 1 | -1, tag: Tag): Prim => ({
    kind: 'cone', base: [q.x, up === 1 ? 0 : BOARD_BOTTOM_Y, q.z], up,
    radius: SOLDER_BASE_DIAMETER_MM / 2, height: SOLDER_HEIGHT_MM, color: COLORS.solder, tag
  })
  const jointTag = (id: string, h: Hole, net: string | null): Tag =>
    ({ kind: 'joint', id, net, label: `${id} joint at ${holeName(h)}` })
  /** A vertical conductor end through its hole, from y0 down to the cone under the board. */
  const through = (q: XZ, y0: number, r: number, color: string, tag: Tag): Prim =>
    ({ kind: 'cylinder', a: [q.x, Math.max(y0, 0), q.z], b: [q.x, Math.min(y0, THROUGH_END_Y), q.z], radius: r, color, tag })

  // ---- Occupancy for the laid-wire lift -----------------------------------------
  const occ = new Map<string, Occupant[]>() // "key|side"
  const occupy = (h: Hole, side: Side, o: Occupant) => {
    const k = `${holeKey(h)}|${side}`
    occ.set(k, [...(occ.get(k) ?? []), o])
  }

  // ---- Trails ------------------------------------------------------------------
  for (const t of board.trails) {
    const pts = dedupPoints(t.points.map(parseHole))
    if (t.points.length < 2) {
      skipped.push(`trail ${t.id}: ${t.points.length} point${t.points.length === 1 ? '' : 's'}, skipped`)
      continue
    }
    if (pts.length < 2) {
      skipped.push(`trail ${t.id}: zero length (all points at ${t.points[0]}), skipped`)
      continue
    }
    for (const h of walkHoles(pts)) occupy(h, t.side, { owner: t.id, top: BARE_WIRE_DIAMETER_MM, halfW: BARE_R })
    const net = conductorNet('trail', t.id)
    const tag: Tag = { kind: 'trail', id: t.id, net, label: `trail ${t.id}` }
    const y = lyingY(t.side, BARE_R)
    out.push({ kind: 'tube', points: pts.map((h): V3 => [pos(h).x, y, pos(h).z]), radius: BARE_R, color: COLORS.copper, tag })
    const solderAt = [pts[0]!, pts[pts.length - 1]!, ...t.joints.map(parseHole)]
    for (const h of solderAt) {
      const q = pos(h)
      if (t.side === 'bottom') out.push(cone(q, -1, jointTag(t.id, h, net)))
      else if (!oneSided) out.push(cone(q, 1, jointTag(t.id, h, net)))
      else {
        // No top pads: the trail end goes down through its hole and is soldered underneath.
        out.push(through(q, y, BARE_R, COLORS.copper, tag), cone(q, -1, jointTag(t.id, h, net)))
      }
    }
  }

  // ---- Leg folds -----------------------------------------------------------------
  const leadHole = new Map<string, Hole>()
  for (const part of placeable)
    for (const pin of placePart(part).pins) leadHole.set(`${part.ref}.${pin.name}`, pin.hole)
  for (const f of board.legFolds) {
    const from = leadHole.get(f.lead)
    if (!from) {
      skipped.push(`leg fold ${f.lead}: unknown lead, skipped`)
      continue
    }
    const to = parseHole(f.to)
    const net = groupNet(conn.groupOfLead.get(f.lead))
    // The leg itself is drawn on the footprint pitch.
    const a = pos(from, FOOTPRINT_PITCH_MM)
    const b = pos(to)
    const y = lyingY('bottom', LEG_R)
    out.push({
      kind: 'tube', points: [[a.x, y, a.z], [b.x, y, b.z]], radius: LEG_R, color: COLORS.leg,
      tag: { kind: 'fold', id: f.lead, net, label: `${f.lead} folded to ${f.to}` }
    })
    out.push(cone(a, -1, jointTag(f.lead, from, net)), cone(b, -1, jointTag(f.lead, to, net)))
    const path = from.col === to.col || from.row === to.row ? straightRun(from, to) : [from, to]
    for (const h of path) occupy(h, 'bottom', { owner: f.lead, top: LEG_DIAMETER_MM, halfW: LEG_R })
  }

  // ---- Wires ---------------------------------------------------------------------
  const wires = board.wires.map((w) => {
    const raw = w.points.map(parseHole)
    const pts = dedupPoints(raw)
    let skip: string | null = null
    if (raw.length < 2) skip = `wire ${w.id}: ${raw.length} point${raw.length === 1 ? '' : 's'}, skipped`
    else if (w.kind === 'flying' && holeKey(raw[0]!) === holeKey(raw[raw.length - 1]!))
      skip = `wire ${w.id}: both ends in hole ${w.points[0]}, skipped`
    else if (pts.length < 2) skip = `wire ${w.id}: zero length (all points at ${w.points[0]}), skipped`
    return { w, raw, skip }
  })
  // Every wire end stands an insulated diameter off the surface (laid ends may be bare).
  for (const { w, raw, skip } of wires) {
    if (skip) continue
    const ends: [Hole, number][] = [[raw[0]!, 0], [raw[raw.length - 1]!, raw.length - 2]]
    for (const [h, seg] of ends) {
      const bare = w.kind === 'laid' && w.bareSegments.includes(seg)
      occupy(h, w.side, { owner: w.id, top: bare ? BARE_WIRE_DIAMETER_MM : INSULATED_WIRE_DIAMETER_MM, halfW: bare ? BARE_R : INS_R })
    }
  }

  for (const { w, raw, skip } of wires) {
    if (skip) {
      skipped.push(skip)
      continue
    }
    const net = conductorNet('wire', w.id)
    const tag: Tag = { kind: 'wire', id: w.id, net, label: `${w.kind} wire ${w.id}` }
    const insColor = w.color ?? netColor(net) ?? COLORS.insulatedFallback
    const first = raw[0]!
    const last = raw[raw.length - 1]!
    let yFirst: number
    let yLast: number

    if (w.kind === 'flying') {
      const peak = Math.min(15, Math.max(3, board.bench.flyingSlackMm / 2))
      const a = pos(first)
      const b = pos(last)
      const base = lyingY(w.side, INS_R)
      const sign = w.side === 'top' ? 1 : -1
      const points: V3[] = []
      for (let i = 0; i < FLYING_POINTS; i++) {
        const t = i / (FLYING_POINTS - 1)
        const y = base + sign * (peak - INS_R) * Math.sin(Math.PI * t)
        points.push([a.x + (b.x - a.x) * t, y, a.z + (b.z - a.z) * t])
      }
      out.push({ kind: 'tube', points, radius: INS_R, color: insColor, tag })
      yFirst = yLast = base
    } else {
      const segs = laidWire(raw, w.bareSegments, w.side, w.id, pitch, pos, occ)
      for (const s of segs) out.push({ kind: 'tube', points: s.points, radius: s.bare ? BARE_R : INS_R, color: s.bare ? COLORS.copper : insColor, tag })
      yFirst = segs[0]!.points[0]![1]
      const lastSeg = segs[segs.length - 1]!
      yLast = lastSeg.points[lastSeg.points.length - 1]![1]
      // Later wires lift over this one at its actual height.
      for (const o of segs.flatMap(s => s.over)) occupy(o.hole, w.side, o.occ)
    }

    // Ends go through their holes and are soldered underneath (connectivity solders every wire end on the bottom).
    for (const [h, y] of [[first, yFirst], [last, yLast]] as const) {
      const q = pos(h)
      out.push(through(q, y, BARE_R, COLORS.copper, tag), cone(q, -1, jointTag(w.id, h, net)))
    }
    for (const j of w.joints) {
      const h = parseHole(j)
      if (w.side === 'bottom') out.push(cone(pos(h), -1, jointTag(w.id, h, net)))
      else if (!oneSided) out.push(cone(pos(h), 1, jointTag(w.id, h, net)))
    }
  }

  // ---- Solder bridges --------------------------------------------------------------
  for (const sb of board.solderBridges) {
    const ha = parseHole(sb.a)
    const hb = parseHole(sb.b)
    const a = pos(ha)
    const b = pos(hb)
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz) + BRIDGE_WIDTH_MM
    const y = sb.side === 'top' ? BRIDGE_HEIGHT_MM / 2 : BOARD_BOTTOM_Y - BRIDGE_HEIGHT_MM / 2
    const center: V3 = [(a.x + b.x) / 2, y, (a.z + b.z) / 2]
    const tag: Tag = { kind: 'bridge', id: `${sb.a}-${sb.b}`, net: groupNet(conn.groupAtHole(ha, sb.side)), label: `solder bridge ${sb.a}-${sb.b}` }
    const along: Prim = Math.abs(dx) < 1e-9
      ? { kind: 'box', center, size: [BRIDGE_WIDTH_MM, BRIDGE_HEIGHT_MM, len], color: COLORS.bridge, tag }
      : Math.abs(dz) < 1e-9
        ? { kind: 'box', center, size: [len, BRIDGE_HEIGHT_MM, BRIDGE_WIDTH_MM], color: COLORS.bridge, tag }
        // rotY: local +x maps to (cos, 0, -sin), as for part boxes.
        : { kind: 'box', center, size: [len, BRIDGE_HEIGHT_MM, BRIDGE_WIDTH_MM], rotY: Math.atan2(-dz, dx), color: COLORS.bridge, tag }
    out.push(along)
  }

  return out
}

interface Stretch {
  bare: boolean
  points: V3[]
  /** This stretch's own occupancy of each hole it passes, at its lifted height. */
  over: { hole: Hole, occ: Occupant }[]
}

/**
 * A laid wire as bare/insulated stretches lying on its side. Over a hole another conductor
 * occupies on that side, it is lifted so its underside clears that conductor's top: flat
 * across the conductor's width, ramping linearly to the surface one pitch either way.
 * The wire's own end holes are not lifted: it dives into the hole there.
 */
function laidWire(
  raw: Hole[], bareSegments: number[], side: Side, id: string, pitch: number,
  pos: (h: Hole) => XZ, occ: Map<string, Occupant[]>
): Stretch[] {
  // Segments with their arc-length range, zero-length steps dropped.
  interface Seg { a: Hole, b: Hole, s0: number, s1: number, bare: boolean }
  const segs: Seg[] = []
  let s = 0
  for (let i = 0; i + 1 < raw.length; i++) {
    const a = raw[i]!
    const b = raw[i + 1]!
    if (holeKey(a) === holeKey(b)) continue
    const len = Math.hypot(pos(b).x - pos(a).x, pos(b).z - pos(a).z)
    segs.push({ a, b, s0: s, s1: s + len, bare: bareSegments.includes(i) })
    s += len
  }
  const total = s

  // Walked holes with their arc position (corners once).
  const walked: { hole: Hole, s: number, seg: number }[] = []
  segs.forEach((g, gi) => {
    const run = straightRun(g.a, g.b)
    run.forEach((h, k) => {
      if (k === 0 && walked.length) return
      walked.push({ hole: h, s: g.s0 + (k / (run.length - 1)) * (g.s1 - g.s0), seg: gi })
    })
  })

  // Lift requirements at holes other conductors occupy.
  const needs: { s: number, top: number, halfW: number }[] = []
  walked.forEach((wh, i) => {
    if (i === 0 || i === walked.length - 1) return
    const others = (occ.get(`${holeKey(wh.hole)}|${side}`) ?? []).filter(o => o.owner !== id)
    if (!others.length) return
    needs.push({ s: wh.s, top: Math.max(...others.map(o => o.top)), halfW: Math.max(...others.map(o => o.halfW)) })
  })
  const lift = (at: number) => {
    let v = 0
    for (const n of needs) {
      const d = Math.abs(at - n.s)
      const f = d <= n.halfW ? 1 : d >= pitch ? 0 : (pitch - d) / (pitch - n.halfW)
      v = Math.max(v, n.top * f)
    }
    return v
  }
  const samples = new Set<number>([0, total, ...segs.map(g => g.s0)])
  for (const n of needs) for (const d of [-pitch, -n.halfW, 0, n.halfW, pitch]) samples.add(Math.min(total, Math.max(0, n.s + d)))
  const sorted = [...samples].sort((a, b) => a - b)

  const stretches: Stretch[] = []
  segs.forEach((g, gi) => {
    const r = g.bare ? BARE_R : INS_R
    const pa = pos(g.a)
    const pb = pos(g.b)
    const at = (q: number): V3 => {
      const t = (q - g.s0) / (g.s1 - g.s0)
      return [pa.x + (pb.x - pa.x) * t, lyingY(side, r, lift(q)), pa.z + (pb.z - pa.z) * t]
    }
    const pts = sorted.filter(q => q >= g.s0 - 1e-9 && q <= g.s1 + 1e-9).map(at)
    const over = walked.filter(wh => wh.seg === gi).map(wh => ({
      hole: wh.hole, occ: { owner: id, top: lift(wh.s) + 2 * r, halfW: r }
    }))
    const prev = stretches[stretches.length - 1]
    if (prev && prev.bare === g.bare) {
      prev.points.push(...pts.slice(1))
      prev.over.push(...over)
    } else stretches.push({ bare: g.bare, points: pts, over })
  })
  return stretches
}
