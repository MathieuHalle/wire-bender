// Rule logic ported from perfwire solver.py erc_audit/topology_audit, Apache-2.0
//
// Shared types and the facts every rule group reads: placed parts, what sits in each
// hole, where each trail and wire runs, and the connectivity graph.
import { buildConnectivity, type Connectivity } from '../connectivity'
import { stripSegments } from '../strips'
import { placePart, type PlacedPart } from '../footprints'
import { holeKey, holeName, parseHole, pathHoles, type Hole } from '../holes'
import type { BoardFile, HoleName, PinRole, Side } from '../schema'
import { holeExists } from '../boardShape'
import { holeLabel, stripLabel } from '../holeLabel'

export type Severity = 'error' | 'warning' | 'caution'
export type RuleId = 'openNet' | 'short' | 'singleLeadNet' | 'contention' | 'twoInOneHole'
  | 'bodyCollision' | 'underBody' | 'touchesTab' | 'blockedHole' | 'keepAway' | 'adjacent' | 'missingJoint'
  | 'cutProposal' | 'onCut' | 'idleCut' | 'overOpening'
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
  /** Holes along its bare stretches (a trail: all of them; a flying wire: none). */
  bare: Hole[]
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
  /** Sides that have pads: bottom only on a one-sided board (and on a breadboard, the clips). */
  sides: Side[]
  /** The strips' conductor ids (`B1-B10`). */
  stripIds: Set<string>
  /** A hole as messages name it: `a12 (D12)` on a board with printed row names (`holeLabel`). */
  label(h: Hole): string
  onBoard(h: Hole): boolean
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
    const holes = pathHoles(t.points.map(parseHole))
    runs.push({ kind: 'trail', id: t.id, side: t.side, holes, joints: t.joints.map(parseHole), ends: [], bare: holes })
  }
  for (const w of board.wires) {
    const pts = w.points.map(parseHole)
    for (const end of [pts[0]!, pts[pts.length - 1]!]) push(wireEndsAt, holeKey(end), w.id)
    const ends = [pts[0]!, pts[pts.length - 1]!]
    const laid = w.kind === 'laid'
    runs.push({
      kind: 'wire', id: w.id, side: w.side, holes: laid ? pathHoles(pts) : [], joints: w.joints.map(parseHole), ends,
      bare: laid && w.bareSegments.length ? pathHoles(pts, w.bareSegments) : []
    })
  }

  return {
    board, conn, placed, leads,
    leadById: new Map(leads.map(l => [l.id, l])),
    leadsAt, wireEndsAt, runs,
    runById: new Map(runs.map(r => [r.id, r])),
    sides: board.board.type === 'two-sided' ? ['bottom', 'top'] : ['bottom'],
    stripIds: new Set(stripSegments(board.board, board.cuts).map(s => s.id)),
    label: h => holeLabel(board.board, h),
    // In the grid and inside the board's shape.
    onBoard: h => holeExists(board.board, h)
  }
}

/** "A", "A or B", "A, B or C". */
export function joinOr(xs: string[]): string {
  if (xs.length <= 1) return xs.join('')
  return `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`
}

/** "A", "A and B", "A, B and C". */
export function joinAnd(xs: string[]): string {
  if (xs.length <= 1) return xs.join('')
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

/** "trail T1" or "wire W1" for a run id, "strip B1–B10" for a strip id; the id itself otherwise. */
export function runLabel(ctx: CheckContext, id: string): string {
  const r = ctx.runById.get(id)
  if (r) return `${r.kind} ${id}`
  return ctx.stripIds.has(id) ? stripLabel(ctx.board.board, id) : id
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
