import type { BoardFile, Part, Side } from './schema'
import { holeKey, holeMm, holeName, parseHole, pathHoles, walkHoles, type Hole } from './holes'
import { FOOTPRINTS, placePart, rotateOffset } from './footprints'
import { OVERLAP_TOLERANCE_MM } from './check/placement'

/** Quarter turns clockwise on screen, as `rotateOffset` turns. */
export type Turns = 0 | 1 | 2 | 3

/** The grabbed hole `from` lands on `to`, then everything turns `turns` times about `to`. */
export interface Placement { from: Hole, to: Hole, turns: Turns }

/**
 * `board` is the moved board (the preview draws it, red when `reason` is set); only
 * `reason === null` may be applied. One refusal cannot write the moved board: a part or a
 * whole wire pushed past the top or left edge (those holes have no name). It returns the board
 * unmoved and `ghost`, the placement to draw the original through, so the copy still shows
 * where it would land. (A wire end aimed past that edge has no ghost: it stays unmoved.)
 */
export interface MoveResult { board: BoardFile, reason: string | null, ghost?: Placement }

export function mapHole(h: Hole, p: Placement): Hole {
  const r = rotateOffset(h.col - p.from.col, h.row - p.from.row, 90 * p.turns)
  return { col: p.to.col + r.dx, row: p.to.row + r.dy }
}

const mapName = (name: string, p: Placement) => holeName(mapHole(parseHole(name), p))

function movedPart(part: Part, p: Placement): Part {
  const fp = FOOTPRINTS[part.footprint]!
  if (fp.twoLead) {
    const to = part.to ?? holeName({ col: parseHole(part.at).col + fp.twoLead.minSpan, row: parseHole(part.at).row })
    return { ...part, at: mapName(part.at, p), to: mapName(to, p) }
  }
  return { ...part, at: mapName(part.at, p), rotation: ((part.rotation + 90 * p.turns) % 360) as Part['rotation'] }
}

/** What a part is in conflict with, keyed `<rule>|<other ref>`: shared, under, over, overlap. */
function partConflicts(board: BoardFile, ref: string): Set<string> {
  const out = new Set<string>()
  const placed = board.parts.map(placePart)
  const me = placed.find(pp => pp.part.ref === ref)
  if (!me) return out
  const mine = new Set(me.pins.map(x => holeKey(x.hole)))
  const myBody = new Set(me.bodyHoles.map(holeKey))
  for (const o of placed) {
    if (o === me) continue
    const theirs = new Set(o.pins.map(x => holeKey(x.hole)))
    const theirBody = new Set(o.bodyHoles.map(holeKey))
    const other = o.part.ref
    if ([...mine].some(k => theirs.has(k))) out.add(`shared|${other}`)
    if ([...mine].some(k => theirBody.has(k))) out.add(`under|${other}`)
    if ([...theirs].some(k => myBody.has(k))) out.add(`over|${other}`)
    const a = me.bodyRectMm
    const b = o.bodyRectMm
    const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    if (dx > OVERLAP_TOLERANCE_MM && dy > OVERLAP_TOLERANCE_MM) out.add(`overlap|${other}`)
  }
  return out
}

/** The first of the part's pin holes that another part's pin shares. */
function sharedHoleName(board: BoardFile, ref: string, other: string): string {
  const mine = placePart(board.parts.find(x => x.ref === ref)!).pins
  const theirs = new Set(placePart(board.parts.find(x => x.ref === other)!).pins.map(x => holeKey(x.hole)))
  return holeName(mine.find(x => theirs.has(holeKey(x.hole)))!.hole)
}

const message = (board: BoardFile, ref: string, key: string): string => {
  const [rule, other] = key.split('|') as [string, string]
  switch (rule) {
    case 'shared': return `${ref} would share hole ${sharedHoleName(board, ref, other)} with ${other}.`
    case 'under': return `A leg of ${ref} would be under ${other}.`
    case 'over': return `${ref} would sit over a leg of ${other}.`
    default: return `${ref} would overlap ${other}.`
  }
}

export function movePart(board: BoardFile, ref: string, p: Placement): MoveResult {
  const idx = board.parts.findIndex(x => x.ref === ref)
  if (idx < 0) return { board, reason: `No part ${ref}.` }

  const prefix = `${ref}.`
  // A hole left of column 1 or above row A has no name, so the moved board cannot be written: the
  // part is off the board, and the board comes back unmoved.
  const part = board.parts[idx]!
  const fp = FOOTPRINTS[part.footprint]!
  const origin = parseHole(part.at)
  const offBoard = `${ref} would be off the board.`
  // Only a fold off the board: its pins are on it, so say which.
  const foldOff = `${ref}'s folded leg would be off the board.`
  const nameless = (h: Hole) => h.col < 1 || h.row < 1
  const named = [
    origin,
    ...(fp.twoLead ? [part.to !== undefined ? parseHole(part.to) : { col: origin.col + fp.twoLead.minSpan, row: origin.row }] : [])
  ].map(h => mapHole(h, p))
  if (named.some(nameless)) return { board, reason: offBoard, ghost: p }
  if (board.legFolds.some(f => f.lead.startsWith(prefix) && nameless(mapHole(parseHole(f.to), p))))
    return { board, reason: foldOff, ghost: p }

  const moved: BoardFile = {
    ...board,
    parts: board.parts.map((x, i) => (i === idx ? movedPart(x, p) : x)),
    legFolds: board.legFolds.map(f => (f.lead.startsWith(prefix) ? { ...f, to: mapName(f.to, p) } : f))
  }

  const pins = placePart(moved.parts[idx]!).pins.map(x => x.hole)
  const folds = moved.legFolds.filter(f => f.lead.startsWith(prefix)).map(f => parseHole(f.to))
  const holes: Hole[] = [...pins, ...folds]
  const { cols, rows } = board.board
  const off = (h: Hole) => h.col < 1 || h.row < 1 || h.col > cols || h.row > rows
  if (pins.some(off)) return { board: moved, reason: offBoard }
  if (folds.some(off)) return { board: moved, reason: foldOff }

  for (const h of holes)
    for (const b of board.board.blocked)
      if (b.holes.some(n => holeKey(parseHole(n)) === holeKey(h)))
        return { board: moved, reason: `Hole ${holeName(h)} is blocked: ${b.reason}` }

  const before = partConflicts(board, ref)
  for (const key of partConflicts(moved, ref))
    if (!before.has(key)) return { board: moved, reason: message(moved, ref, key) }
  return { board: moved, reason: null }
}

const blockedReason = (board: BoardFile, h: Hole): string | null => {
  for (const b of board.board.blocked)
    if (b.holes.some(n => holeKey(parseHole(n)) === holeKey(h))) return `Hole ${holeName(h)} is blocked: ${b.reason}`
  return null
}

export function moveWire(board: BoardFile, id: string, p: Placement): MoveResult {
  const idx = board.wires.findIndex(x => x.id === id)
  if (idx < 0) return { board, reason: `No wire ${id}.` }
  const wire = board.wires[idx]!
  const off = `Wire ${id} would be off the board.`
  const mapped = wire.points.map(n => mapHole(parseHole(n), p))
  // A hole left of column 1 or above row A has no name: the board comes back unmoved.
  if (mapped.some(h => h.col < 1 || h.row < 1)) return { board, reason: off, ghost: p }
  const moved: BoardFile = {
    ...board,
    wires: board.wires.map((x, i) => (i === idx
      ? { ...x, points: mapped.map(holeName), joints: x.joints.map(n => mapName(n, p)) }
      : x))
  }
  const { cols, rows } = board.board
  if (mapped.some(h => h.col > cols || h.row > rows)) return { board: moved, reason: off }
  for (const h of mapped) {
    const reason = blockedReason(board, h)
    if (reason) return { board: moved, reason }
  }
  return { board: moved, reason: null }
}

/** How often a wire through `points` passes each hole-to-hole step, either way round. */
function stepCounts(points: string[]): Map<string, number> {
  const holes = walkHoles(points.map(parseHole))
  const out = new Map<string, number>()
  for (let i = 0; i + 1 < holes.length; i++) {
    const k = [holeKey(holes[i]!), holeKey(holes[i + 1]!)].sort().join('~')
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

/** True when `after` passes some step more often than `before`: the wire would lie on itself. */
function runsOverItself(before: string[], after: string[]): boolean {
  const old = stepCounts(before)
  for (const [k, n] of stepCounts(after)) if (n > 1 && n > (old.get(k) ?? 0)) return true
  return false
}

export type WireEnd = 'first' | 'last'
export type Bend = 'row-first' | 'col-first'

export function moveWireEnd(board: BoardFile, id: string, end: WireEnd, target: Hole, bend: Bend): MoveResult {
  const idx = board.wires.findIndex(x => x.id === id)
  if (idx < 0) return { board, reason: `No wire ${id}.` }
  const wire = board.wires[idx]!
  const pts = wire.points.map(parseHole)
  const first = end === 'first'
  const endIdx = first ? 0 : pts.length - 1
  const prev = pts[first ? 1 : endIdx - 1]!
  const oldEnd = wire.points[endIdx]!
  // A hole left of column 1 or above row A has no name: check before naming it.
  if (target.col < 1 || target.row < 1) return { board, reason: `Wire ${id} would be off the board.` }
  const targetName = holeName(target)

  let points: string[]
  let cornerHole: Hole | null = null
  let bare = wire.bareSegments
  if (wire.kind === 'flying') {
    points = first ? [targetName, wire.points[1]!] : [wire.points[0]!, targetName]
  } else {
    // Onto the point before it counts as in line: the moved wire has a run of length 0 (refused below).
    const inLine = target.row === prev.row || target.col === prev.col
    if (inLine) {
      points = wire.points.slice()
      points[endIdx] = targetName
    } else {
      cornerHole = bend === 'row-first'
        ? { col: target.col, row: prev.row }
        : { col: prev.col, row: target.row }
      const corner = holeName(cornerHole)
      const old = first ? 0 : pts.length - 2
      const wasBare = wire.bareSegments.includes(old)
      if (first) {
        points = [targetName, corner, ...wire.points.slice(1)]
        bare = wire.bareSegments.filter(i => i !== 0).map(i => i + 1)
        if (wasBare) bare = [0, 1, ...bare]
      } else {
        points = [...wire.points.slice(0, -1), corner, targetName]
        bare = wire.bareSegments.filter(i => i !== old)
        if (wasBare) bare = [...bare, old, old + 1]
      }
      bare = bare.slice().sort((a, b) => a - b)
    }
  }

  let joints = wire.joints.map(n => (n === oldEnd ? targetName : n))
  if (wire.kind === 'laid') {
    const reach = new Set(pathHoles(points.map(parseHole)).map(holeKey))
    joints = joints.filter(n => reach.has(holeKey(parseHole(n))))
  }
  joints = [...new Set(joints)]
  const moved: BoardFile = {
    ...board,
    wires: board.wires.map((x, i) => (i === idx ? { ...x, points, bareSegments: bare, joints } : x))
  }
  if (holeKey(target) === holeKey(prev)) {
    const reason = wire.kind === 'flying' ? `Both ends of wire ${id} would be in ${targetName}.` : 'The end can\'t land on the point before it.'
    return { board: moved, reason }
  }
  const { cols, rows } = board.board
  if (target.col > cols || target.row > rows) return { board: moved, reason: `Wire ${id} would be off the board.` }
  if (wire.kind === 'laid' && runsOverItself(wire.points, points))
    return { board: moved, reason: `Wire ${id} would run back over itself.` }
  return { board: moved, reason: blockedReason(board, target) ?? (cornerHole ? blockedReason(board, cornerHole) : null) }
}

/** What a Move click picks up; `at` is the grabbed hole, the `from` of the later `Placement`. */
export type Pick
  = { kind: 'part', ref: string, at: Hole }
    | { kind: 'wire', id: string, at: Hole }
    | { kind: 'wire-end', id: string, end: WireEnd, at: Hole }

const END_REACH = 0.35
const LINE_REACH = 0.3

const dist = (a: { col: number, row: number }, b: { col: number, row: number }) => Math.hypot(a.col - b.col, a.row - b.row)

function segmentDistance(p: { col: number, row: number }, a: Hole, b: Hole): number {
  const dc = b.col - a.col
  const dr = b.row - a.row
  const len2 = dc * dc + dr * dr
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.col - a.col) * dc + (p.row - a.row) * dr) / len2))
  return dist(p, { col: a.col + t * dc, row: a.row + t * dr })
}

/** The hole nearest `point`; on a tie the earlier one in `holes` wins. */
function nearest(holes: Hole[], point: { col: number, row: number }): Hole {
  let best = holes[0]!
  for (const h of holes) if (dist(h, point) < dist(best, point)) best = h
  return best
}

/**
 * What a click at `point` (fractional hole coordinates, holes at whole numbers) picks up on `side`:
 * a wire end, else a laid wire's line, else (top only) a part. Later items are drawn last and win.
 */
export function pickAt(board: BoardFile, side: Side, point: { col: number, row: number }): Pick | null {
  const wires = board.wires.filter(w => w.side === side)
  for (const w of [...wires].reverse()) {
    const ends: [WireEnd, Hole][] = [['first', parseHole(w.points[0]!)], ['last', parseHole(w.points[w.points.length - 1]!)]]
    // Of two ends in reach, the nearer one.
    const hit = ends.filter(([, h]) => dist(h, point) <= END_REACH).sort((x, y) => dist(x[1], point) - dist(y[1], point))[0]
    if (hit) return { kind: 'wire-end', id: w.id, end: hit[0], at: hit[1] }
  }
  for (const w of [...wires].reverse()) {
    if (w.kind !== 'laid') continue
    const pts = w.points.map(parseHole)
    if (pts.some((a, i) => i + 1 < pts.length && segmentDistance(point, a, pts[i + 1]!) <= LINE_REACH)) {
      return { kind: 'wire', id: w.id, at: nearest(pathHoles(pts), point) }
    }
  }
  if (side !== 'top') return null
  const pitch = board.board.pitchMm
  const mm = holeMm(point, pitch)
  const near = { col: Math.round(point.col), row: Math.round(point.row) }
  for (const part of [...board.parts].reverse()) {
    const pp = placePart(part)
    const r = pp.bodyRectMm
    const onHole = [...pp.pins.map(x => x.hole), ...pp.bodyHoles].some(h => h.col === near.col && h.row === near.row)
    const inBody = mm.x >= r.x && mm.x <= r.x + r.w && mm.y >= r.y && mm.y <= r.y + r.h
    if (onHole || inBody) return { kind: 'part', ref: part.ref, at: near }
  }
  return null
}
