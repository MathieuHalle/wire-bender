// Rule logic ported from perfwire solver.py erc_audit/topology_audit, Apache-2.0
//
// Net rules: openNet, short, singleLeadNet, contention, missingJoint.
import { holeKey, holeName } from '../holes'
import type { Connectivity } from '../connectivity'
import { joinAnd, names, runLabel, type CheckContext, type Finding } from './context'

type Contact = Connectivity['contacts'][number]

const pairKey = (c: Contact) => `${c.side}|${holeKey(c.hole)}|${[c.trailId, c.with].sort().join('|')}`

/** Contacts with a crossing of two bare conductors kept once (it is recorded both ways). */
function uniqueContacts(contacts: Contact[]): Contact[] {
  const seen = new Set<string>()
  return contacts.filter((c) => {
    const k = pairKey(c)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function describeContact(ctx: CheckContext, c: Contact): string {
  const who = runLabel(ctx, c.trailId)
  const at = holeName(c.hole)
  if (ctx.leadById.has(c.with)) return `${who} passes over ${c.with} at ${at}`
  if (ctx.runById.has(c.with)) {
    const crossing = ctx.conn.contacts.some(o =>
      o.trailId === c.with && o.with === c.trailId && o.side === c.side && holeKey(o.hole) === holeKey(c.hole))
    return crossing ? `${who} crosses ${runLabel(ctx, c.with)} at ${at}` : `${who} touches ${runLabel(ctx, c.with)} at ${at}`
  }
  return `${who} touches ${c.with} at ${at}`
}

function groupOfRun(ctx: CheckContext, id: string): number {
  return ctx.conn.groups.findIndex(g => g.conductors.some(x => (x.kind === 'trail' || x.kind === 'wire') && x.id === id))
}

export function netRules(ctx: CheckContext): Finding[] {
  const out: Finding[] = []
  const { conn } = ctx

  // Leads of each net, in board order.
  const leadsOfNet = new Map<string, string[]>()
  for (const l of ctx.leads) {
    if (l.net === null) continue // NC pins never count
    leadsOfNet.set(l.net, [...(leadsOfNet.get(l.net) ?? []), l.id])
  }
  const holeOf = (id: string) => ctx.leadById.get(id)!.hole

  for (const [net, ids] of leadsOfNet) {
    if (ids.length === 1) {
      out.push({
        rule: 'singleLeadNet', severity: 'warning', holes: names([holeOf(ids[0]!)]),
        message: `Single lead: net ${net} has only one lead (${ids[0]} at ${holeName(holeOf(ids[0]!))})`
      })
      continue
    }
    const pieces = new Map<number, string[]>()
    for (const id of ids) {
      const g = conn.groupOfLead.get(id)!
      pieces.set(g, [...(pieces.get(g) ?? []), id])
    }
    if (pieces.size > 1) {
      const parts = [...pieces.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p)
      out.push({
        rule: 'openNet', severity: 'error', holes: names(parts.flat().map(holeOf)),
        message: `Open net: ${net} is in ${parts.length} separate pieces: ${parts.map(p => p.join(', ')).join(' | ')}`
      })
    }
  }

  const contacts = uniqueContacts(conn.contacts)
  conn.groups.forEach((g, gi) => {
    if (g.nets.length >= 2) {
      const netLeads = g.leads.filter(id => ctx.leadById.get(id)?.net != null)
      const cause = contacts.filter(c => !c.sameNet && groupOfRun(ctx, c.trailId) === gi)
      let why: string
      if (cause.length) why = cause.map(c => describeContact(ctx, c)).join('; ')
      else {
        const runs = g.conductors.flatMap(x => (x.kind === 'trail' || x.kind === 'wire') ? [`${x.kind} ${x.id}`] : [])
        why = runs.length ? `${joinAnd(netLeads)} via ${joinAnd(runs)}` : joinAnd(netLeads)
      }
      out.push({
        rule: 'short', severity: 'error',
        holes: names([...cause.map(c => c.hole), ...netLeads.map(holeOf)]),
        message: `Short: nets ${joinAnd(g.nets)} are joined (${why})`
      })
    }
    const outs = g.leads.filter(id => ctx.leadById.get(id)?.role === 'out')
    if (outs.length >= 2) {
      const net = g.nets.length ? ` (net ${joinAnd(g.nets)})` : ''
      out.push({
        rule: 'contention', severity: 'error', holes: names(outs.map(holeOf)),
        message: `Contention: ${joinAnd(outs)} are all outputs on one connection${net}`
      })
    }
  })

  // One missing joint per conductor pair per hole: a same-net crossing is proposed for both trails.
  const seen = new Set<string>()
  for (const pj of conn.proposedJoints) {
    const c = conn.contacts.find(x => x.sameNet && x.trailId === pj.trailId && holeKey(x.hole) === holeKey(pj.hole))
    const k = c ? pairKey(c) : `${pj.trailId}|${holeKey(pj.hole)}`
    if (seen.has(k)) continue
    seen.add(k)
    const what = c ? describeContact(ctx, c) : `${runLabel(ctx, pj.trailId)} passes ${holeName(pj.hole)}`
    out.push({
      rule: 'missingJoint', severity: 'warning', holes: names([pj.hole]),
      message: `Missing joint: ${what} without a solder joint; add ${holeName(pj.hole)} to its joints`
    })
  }
  return out
}
