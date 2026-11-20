// The Block tool's edits: a no-go zone or a cutout from two corner holes, a mounting hole at a
// point, and taking any of them away again. Every result is validated like a board file, so the
// tool can't make a board the format refuses (a cutout at the edge, two that overlap).
import { holeExists } from './boardShape'
import { cutoutShape, mountingShapes, signedDistance } from './features'
import { holeKey, holeMm, holeName, parseHole, type Hole } from './holes'
import { parseBoard, type BoardFile, type MountingHole } from './schema'

export type FeatureEdit = { ok: true, board: BoardFile, what: string } | { ok: false, reason: string }

/** The usual mounting holes: the screw, its hole, and room for its head or standoff past the hole's edge. */
export const MOUNT_SIZES = [
  { id: 'M2', diameterMm: 2.2, clearanceMm: 1.3 },
  { id: 'M2.5', diameterMm: 2.7, clearanceMm: 1.4 },
  { id: 'M3', diameterMm: 3.2, clearanceMm: 1.5 }
] as const
export type MountSize = (typeof MOUNT_SIZES)[number]['id']

const fail = (reason: string): FeatureEdit => ({ ok: false, reason })

/** The rectangle of holes between two corners, row by row. */
function rectHoles(a: Hole, b: Hole): Hole[] {
  const out: Hole[] = []
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++)
    for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col++) out.push({ col, row })
  return out
}

/** The board if the format reads it, else its first error, without the path. */
function valid(next: BoardFile, what: string): FeatureEdit {
  const r = parseBoard(next)
  if (!r.ok) return fail(`Can't add ${what}: ${r.errors[0]!.replace(/^[^:]*: /, '')}.`)
  return { ok: true, board: next, what }
}

/** A no-go zone over the holes from `a` to `b` that the board has and that aren't blocked yet. */
export function addZone(board: BoardFile, a: Hole, b: Hole, reason: string): FeatureEdit {
  const taken = new Set(board.board.blocked.flatMap(z => z.holes))
  const holes = rectHoles(a, b).filter(h => holeExists(board.board, h) && !taken.has(holeName(h))).map(holeName)
  if (!holes.length) return fail('Those holes are all blocked already, or off the board.')
  const label = `a no-go zone (${reason}) ${holeName(a)}–${holeName(b)}`
  return valid({ ...board, board: { ...board.board, blocked: [...board.board.blocked, { holes, reason }] } }, label)
}

/** A cutout of the holes from `a` to `b`, and half a pitch past them. */
export function addGridCutout(board: BoardFile, a: Hole, b: Hole, reason: string): FeatureEdit {
  const lo = { col: Math.min(a.col, b.col), row: Math.min(a.row, b.row) }
  const hi = { col: Math.max(a.col, b.col), row: Math.max(a.row, b.row) }
  const c = { kind: 'grid' as const, from: holeName(lo), to: holeName(hi), ...(reason ? { reason } : {}) }
  return valid({ ...board, board: { ...board.board, cutouts: [...(board.board.cutouts ?? []), c] } }, `a cutout ${c.from}–${c.to}`)
}

/** A mounting hole of that size centred at `at` (board mm), snapped to the nearest half pitch. */
export function addMountingHole(board: BoardFile, at: { x: number, y: number }, size: MountSize): FeatureEdit {
  const s = MOUNT_SIZES.find(m => m.id === size)!
  const half = board.board.pitchMm / 2
  const snap = (v: number) => Math.round(Math.round(v / half) * half * 1000) / 1000
  const m: MountingHole = { x: snap(at.x), y: snap(at.y), diameterMm: s.diameterMm, clearanceMm: s.clearanceMm }
  return valid({ ...board, board: { ...board.board, mountingHoles: [...(board.board.mountingHoles ?? []), m] } }, `an ${size} mounting hole`)
}

/**
 * Takes away what is at `at` (board mm): a mounting hole (within its clearance), else a cutout
 * (inside it), else the no-go zone holding the nearest hole. Null when there is nothing there.
 */
export function removeFeatureAt(board: BoardFile, at: { x: number, y: number }): FeatureEdit | null {
  const b = board.board
  const mi = (b.mountingHoles ?? []).findIndex(m => signedDistance(mountingShapes(m).clearance, at.x, at.y) <= 0)
  if (mi >= 0) {
    const mountingHoles = b.mountingHoles!.filter((_, i) => i !== mi)
    const { mountingHoles: _m, ...rest } = b
    return { ok: true, board: { ...board, board: mountingHoles.length ? { ...rest, mountingHoles } : rest }, what: 'the mounting hole' }
  }
  const ci = (b.cutouts ?? []).findIndex(c => signedDistance(cutoutShape(b, c), at.x, at.y) <= 0)
  if (ci >= 0) {
    const cutouts = b.cutouts!.filter((_, i) => i !== ci)
    const { cutouts: _c, ...rest } = b
    return { ok: true, board: { ...board, board: cutouts.length ? { ...rest, cutouts } : rest }, what: 'the cutout' }
  }
  const h = { col: Math.round(at.x / b.pitchMm) + 1, row: Math.round(at.y / b.pitchMm) + 1 }
  const near = holeMm(h, b.pitchMm)
  if (Math.hypot(near.x - at.x, near.y - at.y) > b.pitchMm / 2) return null
  const zi = b.blocked.findIndex(z => z.holes.some(n => holeKey(parseHole(n)) === holeKey(h)))
  if (zi < 0) return null
  return { ok: true, board: { ...board, board: { ...b, blocked: b.blocked.filter((_, i) => i !== zi) } }, what: `the no-go zone (${b.blocked[zi]!.reason})` }
}
