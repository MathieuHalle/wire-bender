// Stripboard rules: where to cut a strip that joins two nets (cutProposal), a lead or wire end
// in a cut hole (onCut), and a cut that separates nothing (idleCut).
import { holeKey, holeName, parseHole, type Hole } from '../holes'
import { stripLabel } from '../holeLabel'
import { stripDrilled, stripSegments } from '../strips'
import { joinAnd, joinOr, names, type CheckContext, type Finding } from './context'

export function cutRules(ctx: CheckContext): Finding[] {
  const { board } = ctx
  if (board.board.type === 'breadboard' || !board.board.strips?.length) return []
  const out: Finding[] = []
  const cuts = board.cuts ?? []
  const cutSet = new Set(cuts)
  const bb = board.board

  // Holes something is soldered at, other than a part's lead: a cut there would undo it.
  const busy = new Set<string>(ctx.wireEndsAt.keys())
  for (const t of board.trails) {
    if (t.side !== 'bottom' || !t.points.length) continue
    for (const n of [t.points[0]!, t.points[t.points.length - 1]!, ...t.joints]) busy.add(holeKey(parseHole(n)))
  }
  for (const w of board.wires) if (w.side === 'bottom') for (const n of w.joints) busy.add(holeKey(parseHole(n)))
  for (const f of board.legFolds) busy.add(holeKey(parseHole(f.to)))
  // Bottom trail ends and joints, by hole: soldered to the copper there.
  const trailAt = new Map<string, string[]>()
  for (const t of board.trails) {
    if (t.side !== 'bottom' || !t.points.length) continue
    for (const n of new Set([t.points[0]!, t.points[t.points.length - 1]!, ...t.joints])) {
      const k = holeKey(parseHole(n))
      trailAt.set(k, [...(trailAt.get(k) ?? []), `trail ${t.id}`])
    }
  }

  // ---- cutProposal: a strip piece whose leads carry two nets --------------------------------
  for (const seg of stripSegments(bb, cuts)) {
    const along: { i: number, lead: string, net: string, hole: Hole }[] = []
    seg.holes.forEach((h, i) => {
      for (const id of ctx.leadsAt.get(holeKey(h)) ?? []) {
        const net = ctx.leadById.get(id)!.net
        if (net !== null) along.push({ i, lead: id, net, hole: h })
      }
    })
    for (let k = 1; k < along.length; k++) {
      const a = along[k - 1]!
      const b = along[k]!
      if (a.net === b.net || a.i === b.i) continue
      const free = seg.holes.slice(a.i + 1, b.i).filter(h => !ctx.leadsAt.has(holeKey(h)) && !busy.has(holeKey(h)))
      const which = `${stripLabel(bb, seg.id)} joins ${a.net} (${a.lead} at ${ctx.label(a.hole)}) and ${b.net} (${b.lead} at ${ctx.label(b.hole)})`
      out.push(free.length
        ? {
            rule: 'cutProposal', severity: 'warning', holes: names(ctx, free),
            message: `Cut needed: ${which}. Cut at ${free.length === 1 ? ctx.label(free[0]!) : `one of ${joinOr(free.map(ctx.label))}`}`
          }
        : {
            rule: 'cutProposal', severity: 'warning', holes: names(ctx, [a.hole, b.hole]),
            message: `Cut needed: ${which}, with no free hole between them to cut. Move one of the parts`
          })
    }
  }

  // ---- onCut: something soldered in a hole with no copper ----------------------------------
  for (const n of cutSet) {
    const h = parseHole(n)
    const what = [
      ...(ctx.leadsAt.get(holeKey(h)) ?? []), ...(ctx.wireEndsAt.get(holeKey(h)) ?? []).map(id => `wire ${id}`),
      ...(trailAt.get(holeKey(h)) ?? [])
    ]
    if (what.length)
      out.push({
        rule: 'onCut', severity: 'warning', holes: names(ctx, [h]),
        message: `In a cut hole: ${joinAnd(what)} at ${ctx.label(h)}, where the copper is cut away: there is nothing to solder ${what.length > 1 ? 'them' : 'it'} to`
      })
  }

  // ---- idleCut: both sides carry the same net, or one side carries nothing -------------------
  // Cuts side by side (a double cut) are judged as one: the nets past the whole run of them.
  const netsBeside = (h: Hole | undefined): string[] | null => {
    if (!h) return null
    const gi = ctx.conn.groupAtHole(h, 'bottom')
    const g = gi === null ? null : ctx.conn.groups[gi]!
    return g && g.leads.length ? g.nets : null
  }
  for (const s of bb.strips ?? []) {
    const hs = stripDrilled(s)
    const isCut = (i: number) => cutSet.has(holeName(hs[i]!))
    hs.forEach((h, i) => {
      if (!isCut(i)) return
      let lo = i - 1
      while (lo >= 0 && isCut(lo)) lo--
      let hi = i + 1
      while (hi < hs.length && isCut(hi)) hi++
      const a = netsBeside(hs[lo])
      const b = netsBeside(hs[hi])
      const same = a && b && a.length === 1 && b.length === 1 && a[0] === b[0]
      if (a && b && !same) return
      out.push({
        rule: 'idleCut', severity: 'caution', holes: names(ctx, [h]),
        message: same
          ? `Cut not needed: the cut at ${ctx.label(h)} has ${a![0]} on both sides`
          : `Cut not needed: the cut at ${ctx.label(h)} has nothing connected on ${!a && !b ? 'either side' : 'one side'}`
      })
    })
  }
  return out
}
