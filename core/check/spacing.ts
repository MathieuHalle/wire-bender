// Rule logic ported from perfwire solver.py erc_audit/topology_audit, Apache-2.0
//
// Spacing rules between nets: keepAway (by net class, any distance) and adjacent
// (4-neighbour holes, in severity buckets).
import { holeKey, holeName, type Hole } from '../holes'
import { names, type AdjacencyLevel, type CheckContext, type Finding } from './context'

const LEVEL_WORDS: Record<AdjacencyLevel, string> = {
  supply: 'shorts the supply',
  mcu: 'kills the MCU',
  harmless: 'harmless'
}
const LEVEL_RANK: Record<AdjacencyLevel, number> = { harmless: 0, supply: 1, mcu: 2 }

interface NetHole { hole: Hole, net: string }

export function spacingRules(ctx: CheckContext): Finding[] {
  const { board, conn } = ctx
  const classOf = (net: string) => board.nets[net]?.class

  // Nets carried at each hole, per side with pads. Null (no net, or shorted) is skipped:
  // a short is reported on its own.
  const perSide = ctx.sides.map((side) => {
    const at = new Map<string, NetHole>()
    for (let row = 1; row <= board.board.rows; row++)
      for (let col = 1; col <= board.board.cols; col++) {
        const hole = { col, row }
        const net = conn.netAtHole(hole, side)
        if (net !== null) at.set(holeKey(hole), { hole, net })
      }
    return at
  })

  const out: Finding[] = []

  // ---- keepAway: one finding per rule and net pair, all sides merged -----------------
  board.rules.keepAway.forEach((rule, ri) => {
    const found = new Map<string, { na: string, nb: string, ha: Map<string, Hole>, hb: Map<string, Hole> }>()
    for (const at of perSide) {
      const as = [...at.values()].filter(x => classOf(x.net) === rule.a)
      const bs = [...at.values()].filter(x => classOf(x.net) === rule.b)
      for (const a of as)
        for (const b of bs) {
          if (a.net === b.net) continue
          if (rule.a === rule.b && a.net > b.net) continue // same class: each pair once
          const d = Math.max(Math.abs(a.hole.col - b.hole.col), Math.abs(a.hole.row - b.hole.row))
          if (d > rule.holes) continue
          const k = `${ri}|${a.net}|${b.net}`
          const e = found.get(k) ?? { na: a.net, nb: b.net, ha: new Map(), hb: new Map() }
          e.ha.set(holeKey(a.hole), a.hole)
          e.hb.set(holeKey(b.hole), b.hole)
          found.set(k, e)
        }
    }
    for (const e of found.values()) {
      const ha = sortHoles([...e.ha.values()])
      const hb = sortHoles([...e.hb.values()])
      const unit = rule.holes === 1 ? 'hole' : 'holes'
      out.push({
        rule: 'keepAway', severity: 'warning', holes: names(ctx, [...ha, ...hb]),
        message: `Keep-away: ${rule.a} net ${e.na} (${names(ctx, ha).join(', ')}) is within ${rule.holes} ${unit} `
          + `of ${rule.b} net ${e.nb} (${names(ctx, hb).join(', ')})`
      })
    }
  })

  // ---- adjacent: one finding per hole pair, worst level over the sides -------------
  const refsAt = (h: Hole) => new Set((ctx.leadsAt.get(holeKey(h)) ?? []).map(id => ctx.leadById.get(id)!.ref))
  const levelFor = (a: NetHole, b: NetHole): AdjacencyLevel => {
    const ra = refsAt(a.hole)
    if ([...refsAt(b.hole)].some(r => ra.has(r))) return 'harmless' // neighbouring pins of one part
    const ca = classOf(a.net)
    const cb = classOf(b.net)
    if (ca === undefined || cb === undefined) return 'harmless'
    const rule = board.rules.adjacency.find(r =>
      (r.classes[0] === ca && r.classes[1] === cb) || (r.classes[0] === cb && r.classes[1] === ca))
    return rule?.level ?? 'harmless'
  }
  // Holes where the only copper on that side is an insulated wire stretch lying over them:
  // insulation can't bridge to a neighbour, so they don't count here (keep-away still does).
  const insulatedOnly = ctx.sides.map((side) => {
    const exposed = new Set<string>([...ctx.leadsAt.keys(), ...ctx.wireEndsAt.keys()])
    for (const r of ctx.runs) if (r.side === side) for (const h of r.bare) exposed.add(holeKey(h))
    const only = new Set<string>()
    for (const r of ctx.runs)
      if (r.side === side && r.kind === 'wire')
        for (const h of r.holes) if (!exposed.has(holeKey(h))) only.add(holeKey(h))
    return only
  })
  const pairs = new Map<string, { a: NetHole, b: NetHole, level: AdjacencyLevel }>()
  for (const [si, at] of perSide.entries())
    for (const a of at.values())
      for (const step of [{ col: 1, row: 0 }, { col: 0, row: 1 }]) {
        const b = at.get(holeKey({ col: a.hole.col + step.col, row: a.hole.row + step.row }))
        if (!b || b.net === a.net) continue
        if (insulatedOnly[si]!.has(holeKey(a.hole)) || insulatedOnly[si]!.has(holeKey(b.hole))) continue
        const k = `${holeKey(a.hole)}|${holeKey(b.hole)}`
        const level = levelFor(a, b)
        const prev = pairs.get(k)
        if (!prev || LEVEL_RANK[level] > LEVEL_RANK[prev.level]) pairs.set(k, { a, b, level })
      }
  for (const { a, b, level } of pairs.values())
    out.push({
      rule: 'adjacent', severity: 'caution', level, holes: names(ctx, [a.hole, b.hole]),
      message: `Adjacent: ${a.net} at ${holeName(a.hole)} next to ${b.net} at ${holeName(b.hole)} (${LEVEL_WORDS[level]})`
    })
  return out
}

function sortHoles(hs: Hole[]): Hole[] {
  return [...hs].sort((x, y) => x.row - y.row || x.col - y.col)
}
