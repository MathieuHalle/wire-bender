// Rule logic ported from perfwire solver.py erc_audit/topology_audit, Apache-2.0
//
// Placement rules: twoInOneHole, bodyCollision, underBody, blockedHole.
import { holeKey, holeMm, holeName, parseHole, type Hole } from '../holes'
import { joinAnd, names, type CheckContext, type Finding, type Run } from './context'

/** Bodies may touch: only an overlap beyond this in both axes is a collision. */
const OVERLAP_TOLERANCE_MM = 0.2

/** What occupies each hole, as readable labels, from the given sources. */
class Occupancy {
  private items = new Map<string, { hole: Hole, labels: string[] }>()
  add(h: Hole, label: string) {
    const k = holeKey(h)
    const e = this.items.get(k) ?? { hole: h, labels: [] }
    if (!e.labels.includes(label)) e.labels.push(label)
    this.items.set(k, e)
  }

  at(h: Hole): string[] {
    return this.items.get(holeKey(h))?.labels ?? []
  }

  entries() {
    return [...this.items.values()]
  }
}

/** Holes a run lies over, without its wire ends (those are named as ends). */
const alongOnly = (r: Run) => r.holes.filter(h => !r.ends.some(e => holeKey(e) === holeKey(h)))

export function placementRules(ctx: CheckContext): Finding[] {
  const out: Finding[] = []
  const { board } = ctx

  // ---- twoInOneHole ---------------------------------------------------------------
  const keys = new Set([...ctx.leadsAt.keys(), ...ctx.wireEndsAt.keys()])
  for (const k of keys) {
    const leads = ctx.leadsAt.get(k) ?? []
    const wires = ctx.wireEndsAt.get(k) ?? []
    if (leads.length >= 2 || (leads.length >= 1 && wires.length >= 1)) {
      const h = ctx.leadById.get(leads[0]!)!.hole
      const what = [...leads, ...wires.map(w => `wire ${w} end`)]
      out.push({
        rule: 'twoInOneHole', severity: 'error', holes: names([h]),
        message: `Two in one hole: ${joinAnd(what)} share ${holeName(h)}`
      })
    }
  }

  // ---- bodyCollision --------------------------------------------------------------
  const pitch = board.board.pitchMm
  for (let i = 0; i < ctx.placed.length; i++)
    for (let j = i + 1; j < ctx.placed.length; j++) {
      const a = ctx.placed[i]!.bodyRectMm
      const b = ctx.placed[j]!.bodyRectMm
      const x0 = Math.max(a.x, b.x)
      const x1 = Math.min(a.x + a.w, b.x + b.w)
      const y0 = Math.max(a.y, b.y)
      const y1 = Math.min(a.y + a.h, b.y + b.h)
      if (x1 - x0 <= OVERLAP_TOLERANCE_MM || y1 - y0 <= OVERLAP_TOLERANCE_MM) continue
      const under: Hole[] = []
      for (let row = 1; row <= board.board.rows; row++)
        for (let col = 1; col <= board.board.cols; col++) {
          const m = holeMm({ col, row }, pitch)
          if (m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1) under.push({ col, row })
        }
      const ra = ctx.placed[i]!.part.ref
      const rb = ctx.placed[j]!.part.ref
      out.push({
        rule: 'bodyCollision', severity: 'error',
        holes: names(under.length ? under : [parseHole(ctx.placed[i]!.part.at), parseHole(ctx.placed[j]!.part.at)]),
        message: `Body collision: ${ra} and ${rb} overlap by ${(x1 - x0).toFixed(1)} x ${(y1 - y0).toFixed(1)} mm`
      })
    }

  // ---- underBody ------------------------------------------------------------------
  // Bodies sit on top: other parts' leads, wire ends, and anything on the top side.
  const covered = new Occupancy()
  for (const l of ctx.leads) covered.add(l.hole, l.id)
  for (const r of ctx.runs) {
    for (const h of r.ends) covered.add(h, `wire ${r.id} end`)
    if (r.side !== 'top') continue
    for (const h of alongOnly(r)) covered.add(h, `${r.kind} ${r.id}`)
    for (const h of r.joints) covered.add(h, `${r.kind} ${r.id} joint`)
  }
  for (const pp of ctx.placed) {
    const own = new Set(pp.pins.map(p => `${pp.part.ref}.${p.name}`))
    for (const h of pp.bodyHoles) {
      const what = covered.at(h).filter(x => !own.has(x))
      if (!what.length) continue
      out.push({
        rule: 'underBody', severity: 'error', holes: names([h]),
        message: `Under a body: ${joinAnd(what)} at ${holeName(h)} ${what.length > 1 ? 'are' : 'is'} under the body of ${pp.part.ref}`
      })
    }
  }

  // ---- blockedHole ----------------------------------------------------------------
  for (const pp of ctx.placed)
    for (const p of pp.pins)
      if (!ctx.onBoard(p.hole))
        out.push({
          rule: 'blockedHole', severity: 'error', holes: [pp.part.at],
          message: `Off the board: pin ${pp.part.ref}.${p.name} of ${pp.part.ref} (placed at ${pp.part.at}) lands off the board`
        })

  const reason = new Map<string, string>()
  for (const b of board.board.blocked) for (const n of b.holes) reason.set(holeKey(parseHole(n)), b.reason)
  if (reason.size) {
    const used = new Occupancy()
    for (const l of ctx.leads) used.add(l.hole, l.id)
    for (const r of ctx.runs) {
      for (const h of r.ends) used.add(h, `wire ${r.id} end`)
      for (const h of alongOnly(r)) used.add(h, `${r.kind} ${r.id}`)
      for (const h of r.joints) used.add(h, `${r.kind} ${r.id} joint`)
    }
    for (const { hole, labels } of used.entries()) {
      const why = reason.get(holeKey(hole))
      if (why === undefined) continue
      out.push({
        rule: 'blockedHole', severity: 'error', holes: names([hole]),
        message: `Blocked hole: ${joinAnd(labels)} at ${holeName(hole)}, which is blocked (${why})`
      })
    }
  }
  return out
}
