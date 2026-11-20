import type { BoardFile, Side, Trail, Wire } from './schema'
import { holeKey, holeName, parseHole, straightRun, walkHoles, type Hole } from './holes'
import { placePart } from './footprints'
import { buildConnectivity } from './connectivity'
import { holeExists } from './boardShape'
import { stripIndex } from './strips'
import { blockedReasons } from './features'

/**
 * What the pencil is drawing: a trail, or on a breadboard a jumper (`jumper`: `trailId` is then
 * the wire's id). A jumper needs two points to exist (a wire has at least two), so until the
 * second click its first hole is kept here as `start` and the board is unchanged.
 */
export interface Drawing { trailId: string, side: Side, jumper?: true, start?: string }
export type EditResult = { ok: true, board: BoardFile, drawing: Drawing | null } | { ok: false, reason: string }

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

/** The hole the drawing goes on from (its last point), or null when it is gone. */
export function drawingEnd(board: BoardFile, d: Drawing): string | null {
  if (d.jumper) {
    if (d.start) return d.start
    const w = board.wires.find(x => x.id === d.trailId)
    return w ? w.points[w.points.length - 1]! : null
  }
  const t = board.trails.find(x => x.id === d.trailId)
  return t && t.points.length ? t.points[t.points.length - 1]! : null
}

const NO_SOLDER = 'A breadboard has no solder: the pencil draws jumpers.'

function rejection(board: BoardFile, side: Side, h: Hole): string | null {
  const name = holeName(h)
  // Outside the grid, or a hole the board's shape removed. (A straight run between two holes the
  // board has never crosses a missing one, so the clicked points are all there is to check.)
  if (!holeExists(board.board, h)) return `Hole ${name} is off the board.`
  const k = holeKey(h)
  const why = blockedReasons(board.board, x => holeExists(board.board, x)).get(k)
  if (why !== undefined) return `Hole ${name} is blocked: ${why}`
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
  if (board.board.type === 'breadboard') return fail(NO_SOLDER)
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

/** First unused wire id: "W1", "W2", ... (trail and wire ids are unique together). */
export function nextWireId(board: BoardFile): string {
  const used = new Set([...board.wires.map(w => w.id), ...board.trails.map(t => t.id)])
  let n = 1
  while (used.has(`W${n}`)) n++
  return `W${n}`
}

/**
 * The pencil on a breadboard: a jumper, a laid insulated wire on the top whose ends plug in. The
 * first click picks the start (nothing changes yet), each further click adds a corner along a row
 * or a column, and clicking the last hole again ends it. Holes under a part's body are fine: a
 * jumper end goes in beside the legs as on the bench.
 */
export function jumperClick(board: BoardFile, hole: Hole, drawing: Drawing | null): EditResult {
  const name = holeName(hole)
  if (!holeExists(board.board, hole)) return fail(`Hole ${name} is off the board.`)
  const why = blockedReasons(board.board, x => holeExists(board.board, x)).get(holeKey(hole))
  if (why !== undefined) return fail(`Hole ${name} is blocked: ${why}`)
  if (!drawing) return { ok: true, board, drawing: { trailId: nextWireId(board), side: 'top', jumper: true, start: name } }
  const last = drawingEnd(board, drawing)
  if (last === null) return fail(`Jumper ${drawing.trailId} no longer exists.`)
  if (last === name) return { ok: true, board, drawing: null } // the last hole again: done
  const lh = parseHole(last)
  if (lh.col !== hole.col && lh.row !== hole.row)
    return fail('Jumpers run along a row or a column here: click a hole in the same row or column.')
  if (drawing.start) {
    // The id is taken now, on the board as it is: another edit since the first click may have used it.
    const w: Wire = { id: nextWireId(board), kind: 'laid', side: 'top', points: [drawing.start, name], bareSegments: [], joints: [] }
    return { ok: true, board: { ...board, wires: [...board.wires, w] }, drawing: { trailId: w.id, side: 'top', jumper: true } }
  }
  const wires = board.wires.map(w => (w.id === drawing.trailId ? { ...w, points: [...w.points, name] } : w))
  return { ok: true, board: { ...board, wires }, drawing }
}

/**
 * The Cut tool on a stripboard: cut the strip at `hole`, or put the cut back if it is cut there.
 * Only a drilled strip hole can be cut; a breadboard's clips can't.
 */
export function toggleCut(board: BoardFile, hole: Hole): EditResult {
  const name = holeName(hole)
  if (board.board.type === 'breadboard') return fail('A breadboard\'s clips can\'t be cut.')
  if (!stripIndex(board.board).has(holeKey(hole))) return fail(`Hole ${name} is not on a strip: there is nothing to cut.`)
  if (!holeExists(board.board, hole)) return fail(`Hole ${name} is off the board.`)
  const cuts = board.cuts ?? []
  const next = cuts.includes(name) ? cuts.filter(c => c !== name) : [...cuts, name]
  const { cuts: _, ...rest } = board
  return { ok: true, board: next.length ? { ...rest, cuts: next } : rest, drawing: null }
}

/** On a breadboard, erasing a jumper's segment takes the whole jumper out (it isn't cut in two). */
function eraseJumper(board: BoardFile, a: Hole, b: Hole): EditResult {
  const ka = holeKey(a)
  const kb = holeKey(b)
  const hit = board.wires.find((w) => {
    const path = expand(w.points)
    return path.some((h, i) => {
      const n = path[i + 1]
      return n !== undefined && ((holeKey(h) === ka && holeKey(n) === kb) || (holeKey(h) === kb && holeKey(n) === ka))
    })
  })
  if (!hit) return fail(`No jumper between ${holeName(a)} and ${holeName(b)}.`)
  return { ok: true, board: { ...board, wires: board.wires.filter(w => w !== hit) }, drawing: null }
}

/** Remove the stretch between adjacent holes a and b from the first trail on `side` that runs over it. */
export function eraseSegment(board: BoardFile, side: Side, a: Hole, b: Hole): EditResult {
  if (board.board.type === 'breadboard') return eraseJumper(board, a, b)
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
  if (board.board.type === 'breadboard') return fail(NO_SOLDER)
  const name = holeName(hole)
  const passing = board.trails.filter(t => t.side === side && trailPasses(t, hole))
  if (passing.length === 0) return fail(`No trail on this side at ${name}.`)
  const over = passing.filter(t => !isEnd(t, name))
  if (over.length === 0) return fail('Trail ends are always soldered.')
  const remove = over.every(t => t.joints.includes(name))
  const trails = board.trails.map((t) => {
    if (!over.includes(t)) return t
    return remove ? { ...t, joints: t.joints.filter(j => j !== name) } : addJoint(t, name)
  })
  return { ok: true, board: withTrails(board, trails), drawing: null }
}
