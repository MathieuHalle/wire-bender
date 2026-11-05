// Rule logic ported from perfwire solver.py erc_audit/topology_audit, Apache-2.0
//
// Shared types and the facts every rule group reads: placed parts, what sits in each
// hole, where each trail and wire runs, and the connectivity graph.
import { buildConnectivity, type Connectivity } from '../connectivity'
import { placePart, type PlacedPart } from '../footprints'
import { holeKey, holeName, parseHole, straightRun, type Hole } from '../holes'
import type { BoardFile, HoleName, PinRole, Side } from '../schema'

export type Severity = 'error' | 'warning' | 'caution'
export type RuleId = 'openNet' | 'short' | 'singleLeadNet' | 'contention' | 'twoInOneHole'
  | 'bodyCollision' | 'underBody' | 'blockedHole' | 'keepAway' | 'adjacent' | 'missingJoint'
export type AdjacencyLevel = 'supply' | 'mcu' | 'harmless'

export interface Finding {
  rule: RuleId
  severity: Severity
  level?: AdjacencyLevel
  holes: HoleName[]
  message: string
}

export interface Lead { id: string, ref: string, pin: string, hole: Hole, net: string | null, role: PinRole }

/** A trail or a laid/flying wire and the holes it runs over on its side. */
export interface Run {
  kind: 'trail' | 'wire'
  id: string
  side: Side
  /** Holes it lies over on its side; a flying wire lies over none. */
  holes: Hole[]
  joints: Hole[]
  /** Wire ends (through-hole); none for trails. */
  ends: Hole[]
}

export interface CheckContext {
  board: BoardFile
  conn: Connectivity
  placed: PlacedPart[]
  leads: Lead[]
  leadById: Map<string, Lead>
  /** hole key -> lead ids in that hole */
  leadsAt: Map<string, string[]>
  /** hole key -> wire ids with an end in that hole */
  wireEndsAt: Map<string, string[]>
  runs: Run[]
  runById: Map<string, Run>
  /** Sides that have pads: bottom only on a one-sided board. */
  sides: Side[]
  onBoard(h: Hole): boolean
}

/** Every hole on a polyline, bend points included, without repeats. */
export function pathHoles(points: Hole[]): Hole[] {
  if (points.length === 1) return [points[0]!]
  const seen = new Map<string, Hole>()
  for (let i = 0; i + 1 < points.length; i++)
    for (const h of straightRun(points[i]!, points[i + 1]!)) seen.set(holeKey(h), h)
  return [...seen.values()]
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k)
  if (list) {
    if (!list.includes(v)) list.push(v)
  } else m.set(k, [v])
}

export function buildContext(board: BoardFile): CheckContext {
  const conn = buildConnectivity(board)
  const placed = board.parts.map(placePart)
  const leads: Lead[] = []
  const leadsAt = new Map<string, string[]>()
  for (const pp of placed)
    for (const pin of pp.pins) {
      const lead = { id: `${pp.part.ref}.${pin.name}`, ref: pp.part.ref, pin: pin.name, hole: pin.hole, net: pin.net, role: pin.role }
      leads.push(lead)
      push(leadsAt, holeKey(pin.hole), lead.id)
    }

  const wireEndsAt = new Map<string, string[]>()
  const runs: Run[] = []
  for (const t of board.trails) {
    if (!t.points.length) continue
    runs.push({ kind: 'trail', id: t.id, side: t.side, holes: pathHoles(t.points.map(parseHole)), joints: t.joints.map(parseHole), ends: [] })
  }
  for (const w of board.wires) {
    const pts = w.points.map(parseHole)
    for (const end of [pts[0]!, pts[pts.length - 1]!]) push(wireEndsAt, holeKey(end), w.id)
    const ends = [pts[0]!, pts[pts.length - 1]!]
    runs.push({ kind: 'wire', id: w.id, side: w.side, holes: w.kind === 'laid' ? pathHoles(pts) : [], joints: w.joints.map(parseHole), ends })
  }

  const { cols, rows } = board.board
  return {
    board, conn, placed, leads,
    leadById: new Map(leads.map(l => [l.id, l])),
    leadsAt, wireEndsAt, runs,
    runById: new Map(runs.map(r => [r.id, r])),
    sides: board.board.type === 'two-sided' ? ['bottom', 'top'] : ['bottom'],
    onBoard: h => h.col >= 1 && h.row >= 1 && h.col <= cols && h.row <= rows
  }
}

/** "A", "A and B", "A, B and C". */
export function joinAnd(xs: string[]): string {
  if (xs.length <= 1) return xs.join('')
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

/** "trail T1" or "wire W1" for a run id; the id itself otherwise. */
export function runLabel(ctx: CheckContext, id: string): string {
  const r = ctx.runById.get(id)
  return r ? `${r.kind} ${id}` : id
}

/** Hole names for a finding, without repeats; holes off the board are left out. */
export const names = (ctx: CheckContext, hs: Hole[]): HoleName[] => {
  const out: HoleName[] = []
  for (const h of hs) {
    if (!ctx.onBoard(h)) continue
    const n = holeName(h)
    if (!out.includes(n)) out.push(n)
  }
  return out
}
