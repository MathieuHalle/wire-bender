import type { BoardFile, Part } from './schema'
import { holeKey, holeName, parseHole, type Hole } from './holes'
import { FOOTPRINTS, placePart, rotateOffset } from './footprints'
import { OVERLAP_TOLERANCE_MM } from './check/placement'

/** Quarter turns clockwise on screen, as `rotateOffset` turns. */
export type Turns = 0 | 1 | 2 | 3

/** The grabbed hole `from` lands on `to`, then everything turns `turns` times about `to`. */
export interface Placement { from: Hole, to: Hole, turns: Turns }

/** `board` is always the moved board (the preview draws it, red when `reason` is set); only `reason === null` may be applied. */
export interface MoveResult { board: BoardFile, reason: string | null }

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
  const named = [
    origin,
    ...(fp.twoLead ? [part.to !== undefined ? parseHole(part.to) : { col: origin.col + fp.twoLead.minSpan, row: origin.row }] : []),
    ...board.legFolds.filter(f => f.lead.startsWith(prefix)).map(f => parseHole(f.to))
  ].map(h => mapHole(h, p))
  if (named.some(h => h.col < 1 || h.row < 1)) return { board, reason: `${ref} would be off the board.` }

  const moved: BoardFile = {
    ...board,
    parts: board.parts.map((x, i) => (i === idx ? movedPart(x, p) : x)),
    legFolds: board.legFolds.map(f => (f.lead.startsWith(prefix) ? { ...f, to: mapName(f.to, p) } : f))
  }

  const holes: Hole[] = [
    ...placePart(moved.parts[idx]!).pins.map(x => x.hole),
    ...moved.legFolds.filter(f => f.lead.startsWith(prefix)).map(f => parseHole(f.to))
  ]
  const { cols, rows } = board.board
  if (holes.some(h => h.col < 1 || h.row < 1 || h.col > cols || h.row > rows))
    return { board: moved, reason: `${ref} would be off the board.` }

  for (const h of holes)
    for (const b of board.board.blocked)
      if (b.holes.some(n => holeKey(parseHole(n)) === holeKey(h)))
        return { board: moved, reason: `Hole ${holeName(h)} is blocked: ${b.reason}` }

  const before = partConflicts(board, ref)
  for (const key of partConflicts(moved, ref))
    if (!before.has(key)) return { board: moved, reason: message(moved, ref, key) }
  return { board: moved, reason: null }
}
