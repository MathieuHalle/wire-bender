import type { BoardFile, Side, Trail } from './schema'
import { holeKey, holeName, parseHole, straightRun, walkHoles, type Hole } from './holes'
import { placePart } from './footprints'
import { buildConnectivity } from './connectivity'

export interface Drawing { trailId: string; side: Side }
export type EditResult = { ok: true; board: BoardFile; drawing: Drawing | null } | { ok: false; reason: string }

const fail = (reason: string): EditResult => ({ ok: false, reason })

/** First unused trail id: "T1", "T2", ... */
export function nextTrailId(board: BoardFile): string {
  const used = new Set(board.trails.map(t => t.id))
  let n = 1
  while (used.has(`T${n}`)) n++
  return `T${n}`
}

/** Every hole a trail passes over, in order, corners not repeated. */
const expand = (points: string[]): Hole[] => walkHoles(points.map(parseHole))

const trailPasses = (t: Trail, h: Hole) => expand(t.points).some(x => holeKey(x) === holeKey(h))

function withTrails(board: BoardFile, trails: Trail[]): BoardFile {
  return { ...board, trails }
}

function hasLead(board: BoardFile, h: Hole): boolean {
  const k = holeKey(h)
  return board.parts.some(p => placePart(p).pins.some(pin => holeKey(pin.hole) === k))
}

/** Another trail on this side passes the hole, or a wire (either side: the end goes through the hole) ends there. */
function hasOtherTrace(board: BoardFile, side: Side, h: Hole, exceptTrailId: string | null): boolean {
  if (board.trails.some(t => t.side === side && t.id !== exceptTrailId && trailPasses(t, h))) return true
  const name = holeName(h)
  return board.wires.some(w => (w.points[0] === name || w.points[w.points.length - 1] === name))
}

function rejection(board: BoardFile, side: Side, h: Hole): string | null {
  const name = holeName(h)
  if (h.col < 1 || h.row < 1 || h.col > board.board.cols || h.row > board.board.rows) return `Hole ${name} is off the board.`
  const k = holeKey(h)
  for (const b of board.board.blocked) {
    if (b.holes.some(n => holeKey(parseHole(n)) === k)) return `Hole ${name} is blocked: ${b.reason}`
  }
  if (side === 'top') {
    if (board.board.type === 'one-sided') return 'This board has no pads on the top side.'
    for (const p of board.parts) {
      if (placePart(p).bodyHoles.some(x => holeKey(x) === k)) return `Hole ${name} is under ${p.ref}`
    }
  }
  return null
}

const addJoint = (t: Trail, name: string): Trail =>
  t.joints.includes(name) ? t : { ...t, joints: [...t.joints, name] }

const isEnd = (t: Trail, name: string) => t.points[0] === name || t.points[t.points.length - 1] === name

/** The pencil landed on other trails at `name`: they get the joint too (spec §9b, the tool adds it). */
function jointOthers(trails: Trail[], side: Side, h: Hole, exceptId: string): Trail[] {
  const name = holeName(h)
  return trails.map(t => (t.side === side && t.id !== exceptId && !isEnd(t, name) && trailPasses(t, h) ? addJoint(t, name) : t))
}

/**
 * Joints for the leads a new straight run passes over (ends excluded): a lead of the
 * trail's net, or the first lead with a net when the trail has none yet. A lead of
 * another net gets none (the check reports the short); NC leads never get one.
 */
function leadJoints(board: BoardFile, t: Trail, from: Hole, to: Hole): Trail {
  const nets = buildConnectivity(board).groups.find(g => g.conductors.some(c => c.kind === 'trail' && c.id === t.id))?.nets ?? []
  if (nets.length > 1) return t // already shorted: don't add more
  let net: string | null = nets[0] ?? null
  const netsAt = new Map<string, string[]>()
  for (const p of board.parts)
    for (const pin of placePart(p).pins)
      if (pin.net !== null) netsAt.set(holeKey(pin.hole), [...(netsAt.get(holeKey(pin.hole)) ?? []), pin.net])
  let out = t
  for (const h of straightRun(from, to).slice(1, -1)) {
    const here = netsAt.get(holeKey(h))
    if (!here) continue
    if (net === null) net = here[0]!
    if (here.includes(net)) out = addJoint(out, holeName(h))
  }
  return out
}

export function pencilClick(board: BoardFile, side: Side, hole: Hole, drawing: Drawing | null): EditResult {
  const reason = rejection(board, side, hole)
  if (reason) return fail(reason)
  const name = holeName(hole)

  if (!drawing) {
    const id = nextTrailId(board)
    const t: Trail = { id, side, points: [name], joints: [] }
    const traced = hasOtherTrace(board, side, hole, id)
    const joint = hasLead(board, hole) || traced
    const others = traced ? jointOthers(board.trails, side, hole, id) : board.trails
    return { ok: true, board: withTrails(board, [...others, joint ? addJoint(t, name) : t]), drawing: { trailId: id, side } }
  }

  const cur = board.trails.find(t => t.id === drawing.trailId)
  if (!cur) return fail(`Trail ${drawing.trailId} no longer exists.`)
  const last = cur.points[cur.points.length - 1]!
  if (last === name) {
    const trails = cur.points.length < 2
      ? board.trails.filter(t => t.id !== cur.id)
      : board.trails
    return { ok: true, board: withTrails(board, trails), drawing: null }
  }
  const lh = parseHole(last)
  if (lh.col !== hole.col && lh.row !== hole.row) {
    return fail('Trails run along a row or a column: click a hole in the same row or column.')
  }
  const traced = hasOtherTrace(board, side, hole, cur.id)
  let next: Trail = leadJoints(board, { ...cur, points: [...cur.points, name] }, lh, hole)
  if (traced || hasLead(board, hole)) next = addJoint(next, name)
  const others = traced ? jointOthers(board.trails, side, hole, cur.id) : board.trails
  return {
    ok: true,
    board: withTrails(board, others.map(t => (t.id === cur.id ? next : t))),
    drawing: traced ? null : drawing
  }
}

/** Remove the stretch between adjacent holes a and b from the first trail on `side` that runs over it. */
export function eraseSegment(board: BoardFile, side: Side, a: Hole, b: Hole): EditResult {
  const none = fail(`No trail segment between ${holeName(a)} and ${holeName(b)} on this side.`)
  if (Math.abs(a.col - b.col) + Math.abs(a.row - b.row) !== 1) return none
  const ka = holeKey(a)
  const kb = holeKey(b)
  for (let ti = 0; ti < board.trails.length; ti++) {
    const t = board.trails[ti]!
    if (t.side !== side) continue
    const path = expand(t.points)
    const k = path.findIndex((h, i) => {
      const n = path[i + 1]
      if (!n) return false
      const x = holeKey(h)
      const y = holeKey(n)
      return (x === ka && y === kb) || (x === kb && y === ka)
    })
    if (k < 0) continue
    const corners = new Set(t.points.map(p => holeKey(parseHole(p))))
    const piece = (hs: Hole[]): string[] | null => {
      if (hs.length < 2) return null
      const pts = hs.filter((h, i) => i === 0 || i === hs.length - 1 || corners.has(holeKey(h))).map(holeName)
      return pts.filter((p, i) => i === 0 || p !== pts[i - 1])
    }
    const pieces = [path.slice(0, k + 1), path.slice(k + 1)]
      .map(hs => ({ pts: piece(hs), names: new Set(hs.map(holeName)) }))
      .filter(p => p.pts)
    const used = new Set(board.trails.map(x => x.id))
    const made: Trail[] = pieces.map((p, i) => {
      let id = t.id
      if (i > 0) {
        let n = 1
        while (used.has(`T${n}`)) n++
        id = `T${n}`
        used.add(id)
      }
      return { id, side, points: p.pts!, joints: t.joints.filter(j => p.names.has(j)) }
    })
    const trails = [...board.trails.slice(0, ti), ...made, ...board.trails.slice(ti + 1)]
    return { ok: true, board: withTrails(board, trails), drawing: null }
  }
  return none
}

/**
 * Add a joint at `hole` on every trail of this side that passes it, or remove it if all
 * have one. A trail ending there is soldered anyway and left alone.
 */
export function toggleJoint(board: BoardFile, side: Side, hole: Hole): EditResult {
  const name = holeName(hole)
  const passing = board.trails.filter(t => t.side === side && trailPasses(t, hole))
  if (passing.length === 0) return fail(`No trail on this side at ${name}.`)
  const over = passing.filter(t => !isEnd(t, name))
  if (over.length === 0) return fail('Trail ends are always soldered.')
  const remove = over.every(t => t.joints.includes(name))
  const trails = board.trails.map(t => {
    if (!over.includes(t)) return t
    return remove ? { ...t, joints: t.joints.filter(j => j !== name) } : addJoint(t, name)
  })
  return { ok: true, board: withTrails(board, trails), drawing: null }
}
