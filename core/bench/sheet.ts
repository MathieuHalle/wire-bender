// Bench sheet model: what to place and in which order, which legs to fold, and the
// beep / no-beep meter lists. Pure data; the export renders it.
import { holeName, tryParseHole, type Hole } from '../holes'
import { bodyHeightMm, FOOTPRINT_PITCH_MM, placePart, type PlacedPart } from '../footprints'
import { buildConnectivity } from '../connectivity'
import { runCheck, type CheckResult, type Finding } from '../check'
import type { BoardFile, HoleName } from '../schema'
import { compareIds, netLabel, wireCards, type WireCard } from './cards'

export interface PlacementRow {
  step: number
  ref: string
  name: string
  value?: string
  holes: string
  heightMm: number
  orientation: string
  mounting: 'lying' | 'standing' | 'upright'
}
export interface LegFoldRow { lead: string, from: HoleName, to: HoleName, note: string }
export interface MeterRow { a: string, b: string, expect: 'beep' | 'no beep', why: string, group: string }
export interface BenchModel {
  name: string
  revision: number
  paper: 'letter' | 'a4'
  check: { errors: Finding[], stats: CheckResult['stats'] }
  placement: PlacementRow[]
  cards: WireCard[]
  legFolds: LegFoldRow[]
  mustBeep: MeterRow[]
  mustNotBeep: MeterRow[]
  /** Nets left out of must-beep because their copper is shorted to another net. */
  shortedNets: number
}

const SUPPLY_GROUP = 'Shorts the supply'
const MCU_GROUP = 'Kills the MCU'

const rowName = (row: number) => holeName({ col: 1, row }).replace(/\d+$/, '')

/**
 * Which way a tab or flat side faces: the placed part's tab direction, else from the pin
 * centroid toward the body centre. `pitch` is the one the body rect was placed at (pin
 * holes in mm are (col - 1) * pitch).
 */
function facing(pp: PlacedPart, pitch: number): string {
  const cx = pp.pins.reduce((a, p) => a + p.hole.col, 0) / pp.pins.length
  const cy = pp.pins.reduce((a, p) => a + p.hole.row, 0) / pp.pins.length
  const r = pp.bodyRectMm
  const dx = pp.tab ? pp.tab.dx : r.x + r.w / 2 - (cx - 1) * pitch
  const dy = pp.tab ? pp.tab.dy : r.y + r.h / 2 - (cy - 1) * pitch
  const cols = pp.pins.map(p => p.hole.col)
  const rows = pp.pins.map(p => p.hole.row)
  if (Math.abs(dy) > Math.abs(dx)) {
    const row = dy < 0 ? Math.min(...rows) - 1 : Math.max(...rows) + 1
    return row < 1 ? 'toward the top edge' : `toward row ${rowName(row)}`
  }
  const col = dx < 0 ? Math.min(...cols) - 1 : Math.max(...cols) + 1
  return col < 1 ? 'toward the left edge' : `toward column ${col}`
}

function orientation(pp: PlacedPart, pitch: number): string {
  const pin = (name: string) => pp.pins.find(p => p.name === name)
  switch (pp.fp.mark) {
    case 'pin1': {
      const p = pin('1') ?? pp.pins[0]!
      return `pin 1 at ${holeName(p.hole)}`
    }
    case 'stripe-b': return `stripe (cathode) at ${holeName(pin('b')!.hole)}`
    case 'tab': return `metal tab ${facing(pp, pitch)}`
    case 'flat': return `flat side ${facing(pp, pitch)}`
    default: return 'either way'
  }
}

const byHole = (a: { hole: Hole, id: string }, b: { hole: Hole, id: string }) =>
  a.hole.row - b.hole.row || a.hole.col - b.hole.col || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function benchModel(board: BoardFile): BenchModel {
  const check = runCheck(board)
  const conn = buildConnectivity(board)
  const placed = board.parts.map(placePart)

  const placement = placed
    .map(pp => ({ pp, h: bodyHeightMm(pp.part, pp.fp) }))
    .sort((a, b) => a.h - b.h || compareIds(a.pp.part.ref, b.pp.part.ref))
    .map(({ pp, h }, i): PlacementRow => ({
      step: i + 1,
      ref: pp.part.ref,
      name: pp.part.label ?? pp.fp.name,
      ...(pp.part.value !== undefined ? { value: pp.part.value } : {}),
      holes: pp.pins.map(p => `${p.name}:${holeName(p.hole)}`).join(' '),
      heightMm: h,
      // placePart lays bodies out on the footprint grid, so facing compares on that grid.
      orientation: orientation(pp, FOOTPRINT_PITCH_MM),
      mounting: pp.part.standing && pp.fp.twoLead ? 'standing' : pp.fp.twoLead ? 'lying' : 'upright'
    }))

  const leads = new Map<string, { id: string, hole: Hole, net: string | null }>()
  for (const pp of placed)
    for (const p of pp.pins) {
      const id = `${pp.part.ref}.${p.name}`
      leads.set(id, { id, hole: p.hole, net: p.net })
    }
  const probe = (id: string) => `${id} (${holeName(leads.get(id)!.hole)})`

  const legFolds: LegFoldRow[] = []
  for (const f of board.legFolds) {
    const lead = leads.get(f.lead)
    if (!lead) continue // unknown lead: the check reports it
    const from = holeName(lead.hole)
    legFolds.push({ lead: f.lead, from, to: f.to, note: `fold ${f.lead} (${from}) flat toward ${f.to}, solder both` })
  }

  // ---- must beep: each net, lead to next lead; shorted groups are left to the check ----
  const netLeads = new Map<string, { id: string, hole: Hole }[]>()
  for (const l of leads.values())
    if (l.net !== null) netLeads.set(l.net, [...(netLeads.get(l.net) ?? []), l])
  const mustBeep: MeterRow[] = []
  let shortedNets = 0
  for (const net of [...netLeads.keys()].sort()) {
    const ls = netLeads.get(net)!.sort(byHole)
    if (ls.length < 2) continue
    const gi = conn.groupOfLead.get(ls[0]!.id)
    if (gi === undefined) continue
    if (ls.some(l => (conn.groups[conn.groupOfLead.get(l.id)!]?.nets.length ?? 0) > 1)) {
      shortedNets++
      continue
    }
    const label = netLabel(net)
    for (let i = 0; i + 1 < ls.length; i++)
      mustBeep.push({ a: probe(ls[i]!.id), b: probe(ls[i + 1]!.id), expect: 'beep', why: `${label} continuous`, group: label })
  }

  // ---- must not beep ---------------------------------------------------------------
  const mustNotBeep: MeterRow[] = []
  const seen = new Set<string>()
  const pairKey = (a: string, b: string) => [a, b].sort().join('|')
  const push = (hA: string, hB: string, a: string, b: string, why: string, group: string) => {
    const k = pairKey(hA, hB)
    if (seen.has(k)) return
    seen.add(k)
    mustNotBeep.push({ a, b, expect: 'no beep', why, group })
  }

  const firstLead = (cls: string): string | null => {
    const net = Object.keys(board.nets).filter(n => board.nets[n]!.class === cls).sort().find(n => netLeads.has(n))
    return net === undefined ? null : netLeads.get(net)!.map(l => l.id).sort()[0] ?? null
  }
  for (const rule of board.rules.adjacency) {
    if (rule.level !== 'supply') continue
    const a = firstLead(rule.classes[0])
    const b = firstLead(rule.classes[1])
    if (a === null || b === null) continue
    push(holeName(leads.get(a)!.hole), holeName(leads.get(b)!.hole), probe(a), probe(b), 'supply not shorted', SUPPLY_GROUP)
  }

  const leadAt = (h: HoleName): string => {
    const hole = tryParseHole(h)
    const lead = hole && [...leads.values()].filter(l => l.hole.col === hole.col && l.hole.row === hole.row).map(l => l.id).sort()[0]
    return lead ? `${lead} (${h})` : `hole ${h}`
  }
  for (const f of check.findings) {
    if (f.rule !== 'adjacent' || (f.level !== 'supply' && f.level !== 'mcu') || f.holes.length < 2) continue
    const [h1, h2] = f.holes as [string, string]
    push(h1, h2, leadAt(h1), leadAt(h2), f.message, f.level === 'supply' ? SUPPLY_GROUP : MCU_GROUP)
  }

  return {
    name: board.name,
    revision: board.revision,
    paper: board.bench.paper,
    check: { errors: check.findings.filter(f => f.severity === 'error'), stats: check.stats },
    placement,
    cards: wireCards(board),
    legFolds,
    mustBeep,
    mustNotBeep,
    shortedNets
  }
}
