// Wire cards for the bench: cut length, strip marks and bends for every trail and wire,
// so the owner can cut, strip and bend wire before soldering. Pure: no Node or DOM.
import { holeMm, holeName, parseHole, type Hole } from '../holes'
import { buildConnectivity } from '../connectivity'
import type { BoardFile, HoleName, Side } from '../schema'

export interface CardSegment { from: HoleName, to: HoleName, lengthMm: number, bare: boolean }
/** `index` counts the bends 1..n along the wire from its start. */
export interface Bend { at: HoleName, index: number, angleDeg: 90 | 180, dir: 'left' | 'right' | 'back' }
export interface WireCard {
  id: string
  kind: 'trail' | 'laid' | 'flying'
  side: Side
  net: string | null
  netClass: string | null
  color: string | null
  start: HoleName
  end: HoleName
  /** Straight runs, collinear points merged; lengths exact (not rounded). Empty for flying wires. */
  segments: CardSegment[]
  bends: Bend[]
  breakdown: { pathMm: number, bendsMm: number, leadsMm: number, spareMm: number, slackMm: number }
  /** Sum of the breakdown rounded up to `bench.roundToMm`. */
  cutMm: number
  /** Where bare/insulated changes, measured along the cut wire from its start end. */
  strip: { fromStartMm: number, toBare: boolean }[]
  /** The strip bar in order; sums to `cutMm` (the surplus goes on the last stretch). */
  stretches: { lengthMm: number, bare: boolean }[]
  note?: string
}

const EPS = 1e-9

/** Natural id order: same prefix compares the numeric suffix (T2 < T10), else plain string order. */
export function compareIds(a: string, b: string): number {
  const ma = /^(.*?)(\d+)$/.exec(a)
  const mb = /^(.*?)(\d+)$/.exec(b)
  if (ma && mb && ma[1] === mb[1]) {
    const d = Number(ma[2]) - Number(mb[2])
    if (d !== 0) return d
  }
  return a < b ? -1 : a > b ? 1 : 0
}

interface Run { from: Hole, to: Hole, dir: { x: number, y: number }, bare: boolean }

/** Straight runs of a polyline, zero-length steps dropped, collinear neighbours with the same bare flag merged. */
function runs(points: Hole[], isBare: (i: number) => boolean): Run[] {
  const out: Run[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    const dir = { x: Math.sign(b.col - a.col), y: Math.sign(b.row - a.row) }
    if (dir.x === 0 && dir.y === 0) continue
    const bare = isBare(i)
    const last = out[out.length - 1]
    if (last && last.bare === bare && last.dir.x === dir.x && last.dir.y === dir.y) last.to = b
    else out.push({ from: a, to: b, dir, bare })
  }
  return out
}

function distMm(a: Hole, b: Hole, pitch: number): number {
  const pa = holeMm(a, pitch)
  const pb = holeMm(b, pitch)
  return Math.hypot(pb.x - pa.x, pb.y - pa.y)
}

/** Turns between consecutive runs. Board coordinates are x right, y down; the bottom side is seen from below. */
function bendsOf(rs: Run[], side: Side): Bend[] {
  const out: Bend[] = []
  for (let i = 0; i + 1 < rs.length; i++) {
    const d1 = rs[i]!.dir
    const d2 = rs[i + 1]!.dir
    if (d1.x === d2.x && d1.y === d2.y) continue // straight on (bare/insulated change only)
    const at = holeName(rs[i]!.to)
    if (d1.x === -d2.x && d1.y === -d2.y) {
      out.push({ at, index: out.length + 1, angleDeg: 180, dir: 'back' })
      continue
    }
    // With y down, a positive cross product is a clockwise (right) turn seen from the top.
    const cross = d1.x * d2.y - d1.y * d2.x
    let dir: 'left' | 'right' = cross > 0 ? 'right' : 'left'
    if (side === 'bottom') dir = dir === 'right' ? 'left' : 'right'
    out.push({ at, index: out.length + 1, angleDeg: 90, dir })
  }
  return out
}

function finish(
  bench: BoardFile['bench'],
  pathMm: number,
  bendCount: number,
  slackMm: number,
  middle: { lengthMm: number, bare: boolean }[]
) {
  const breakdown = {
    pathMm,
    bendsMm: bendCount * bench.bendAllowanceMm,
    leadsMm: 2 * bench.endLeadMm,
    spareMm: bench.spareMm,
    slackMm
  }
  const total = breakdown.pathMm + breakdown.bendsMm + breakdown.leadsMm + breakdown.spareMm + breakdown.slackMm
  const r = bench.roundToMm
  const cutMm = r > 0 ? Math.ceil(total / r - EPS) * r : total

  const stretches: { lengthMm: number, bare: boolean }[] = []
  for (const s of [{ lengthMm: bench.endLeadMm, bare: true }, ...middle, { lengthMm: bench.endLeadMm, bare: true }]) {
    if (s.lengthMm <= 0) continue
    const last = stretches[stretches.length - 1]
    if (last && last.bare === s.bare) last.lengthMm += s.lengthMm
    else stretches.push({ ...s })
  }
  const surplus = cutMm - stretches.reduce((a, s) => a + s.lengthMm, 0)
  if (stretches.length) stretches[stretches.length - 1]!.lengthMm += surplus

  const strip: { fromStartMm: number, toBare: boolean }[] = []
  let pos = 0
  for (let i = 0; i < stretches.length; i++) {
    if (i > 0 && stretches[i]!.bare !== stretches[i - 1]!.bare) strip.push({ fromStartMm: pos, toBare: stretches[i]!.bare })
    pos += stretches[i]!.lengthMm
  }
  return { breakdown, cutMm, strip, stretches }
}

export function wireCards(board: BoardFile): WireCard[] {
  const conn = buildConnectivity(board)
  const pitch = board.board.pitchMm
  const bench = board.bench

  const groupNet = (kind: 'trail' | 'wire', id: string): string | null => {
    const g = conn.groups.find(g => g.conductors.some(c => c.kind === kind && c.id === id))
    return g && g.nets.length === 1 ? g.nets[0]! : null
  }
  const netInfo = (net: string | null) => {
    const netClass = net ? board.nets[net]?.class ?? null : null
    const color = (net ? board.nets[net]?.color : undefined) ?? (netClass ? board.netClasses[netClass]?.color : undefined) ?? null
    return { net, netClass, color }
  }

  const polyline = (
    base: Pick<WireCard, 'id' | 'kind' | 'side' | 'net' | 'netClass' | 'color'>,
    pts: Hole[],
    isBare: (i: number) => boolean
  ): WireCard => {
    const rs = runs(pts, isBare)
    const segments = rs.map(r => ({ from: holeName(r.from), to: holeName(r.to), lengthMm: distMm(r.from, r.to, pitch), bare: r.bare }))
    const bends = bendsOf(rs, base.side)
    const pathMm = segments.reduce((a, s) => a + s.lengthMm, 0)
    const rest = finish(bench, pathMm, bends.length, 0, segments.map(s => ({ lengthMm: s.lengthMm, bare: s.bare })))
    return { ...base, start: holeName(pts[0]!), end: holeName(pts[pts.length - 1]!), segments, bends, ...rest }
  }

  const trails = [...board.trails].sort((a, b) => compareIds(a.id, b.id)).map((t): WireCard => {
    const base = { id: t.id, kind: 'trail' as const, side: t.side, ...netInfo(groupNet('trail', t.id)) }
    if (t.points.length < 2) {
      const n = t.points.length
      return {
        ...base,
        start: t.points[0] ?? '',
        end: t.points[0] ?? '',
        segments: [],
        bends: [],
        breakdown: { pathMm: 0, bendsMm: 0, leadsMm: 0, spareMm: 0, slackMm: 0 },
        cutMm: 0,
        strip: [],
        stretches: [],
        note: `half-drawn trail (${n} point${n === 1 ? '' : 's'}), skipped`
      }
    }
    return polyline(base, t.points.map(parseHole), () => true)
  })

  const wires = [...board.wires].sort((a, b) => compareIds(a.id, b.id)).map((w): WireCard => {
    const info = netInfo(groupNet('wire', w.id))
    const base = { id: w.id, kind: w.kind, side: w.side, ...info, color: w.color ?? info.color }
    const pts = w.points.map(parseHole)
    if (w.kind === 'laid') return polyline(base, pts, i => w.bareSegments.includes(i))
    const a = pts[0]!
    const b = pts[pts.length - 1]!
    const pathMm = distMm(a, b, pitch)
    const rest = finish(bench, pathMm, 0, bench.flyingSlackMm, [{ lengthMm: pathMm + bench.flyingSlackMm, bare: false }])
    return { ...base, start: holeName(a), end: holeName(b), segments: [], bends: [], ...rest }
  })

  return [...trails, ...wires]
}
