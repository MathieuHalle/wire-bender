// View helpers for the board drawing: geometry (mm, optionally mirrored), net colours,
// and lit sets for a highlighted group. Pure functions over core/ results (which group
// sits at a hole is core's `groupAtHole`).
import { holeKey, type Hole } from '~core/holes'
import { sideMap } from '~core/sideView'
import type { BoardFile, Side } from '~core/schema'
import type { Conductor, Connectivity } from '~core/connectivity'
import type { PlacedPart } from '~core/footprints'

/** `navigate` only pans (any left-drag) and never edits; the others click to act. */
export type Tool = 'navigate' | 'inspect' | 'pencil' | 'erase' | 'joint'
/** Frame both sides on the canvas, frame one side, or the 3D view. */
export type View = 'both' | Side | '3d'
export type Group = Connectivity['groups'][number]

/** Board mm -> drawing mm. Mirrored flips x so the bottom reads as seen from below. */
export interface Geo {
  pitch: number
  cols: number
  rows: number
  /** x of the last column centre. */
  span: number
  mirrored: boolean
  x(x: number): number
  pt(h: Hole): { x: number, y: number }
  rect(r: { x: number, y: number, w: number, h: number }): { x: number, y: number, w: number, h: number }
}

export function makeGeo(board: BoardFile, mirrored: boolean): Geo {
  const m = sideMap(board, mirrored)
  const span = m.span
  return {
    ...m,
    cols: board.board.cols,
    rows: board.board.rows,
    rect(r) {
      return { x: mirrored ? span - r.x - r.w : r.x, y: r.y, w: r.w, h: r.h }
    }
  }
}

export const FALLBACK_NET = '#8a7a55'
export const NO_NET = '#9aa59f'

export function netColor(board: BoardFile, net: string | null | undefined): string {
  if (!net) return NO_NET
  const n = board.nets[net]
  return n?.color ?? (n?.class ? board.netClasses[n.class]?.color : undefined) ?? FALLBACK_NET
}

export function conductorKey(c: Conductor): string {
  return c.kind === 'pad' ? `pad:${holeKey(c.hole)}:${c.side}` : `${c.kind}:${c.id}`
}

/** What a highlighted group lights up, as lookup sets. */
export interface Lit {
  ids: Set<string> // 'trail:T1', 'wire:W3', 'lead:U1.6'
  pads: Set<string> // 'col,row|side'
}

export function litOf(group: Group | null): Lit | null {
  if (!group) return null
  const ids = new Set<string>()
  const pads = new Set<string>()
  for (const c of group.conductors) {
    if (c.kind === 'pad') pads.add(`${holeKey(c.hole)}|${c.side}`)
    else ids.add(`${c.kind}:${c.id}`)
  }
  return { ids, pads }
}

/** The side to add a proposed joint on: the side of the trail the contact rule names at that hole. */
export function jointSide(board: BoardFile, conn: Connectivity, hole: Hole): Side | null {
  const k = holeKey(hole)
  for (const pj of conn.proposedJoints) {
    if (holeKey(pj.hole) !== k) continue
    const t = board.trails.find(x => x.id === pj.trailId)
    if (t) return t.side
  }
  return null
}

/** Space (mm) around a side's drawing, for the edge labels. */
export const SIDE_MARGIN = 3

/**
 * A side's drawing area in drawing mm: the board outline (half a pitch past the outer
 * holes), everything that overhangs it, and SIDE_MARGIN for the labels. Its size is the
 * same mirrored or not; only its x moves.
 */
export function sideExtent(geo: Geo, placed: PlacedPart[]): { x0: number, y0: number, x1: number, y1: number } {
  const half = geo.pitch / 2
  let x0 = -half
  let y0 = -half
  let x1 = geo.span + half
  let y1 = (geo.rows - 1) * geo.pitch + half
  for (const p of placed) {
    const r = geo.rect(p.bodyRectMm)
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x0, y0, x1, y1 }
}

/** The SVG viewBox of a side: its extent plus the label margin. */
export function sideBox(geo: Geo, placed: PlacedPart[]): { x: number, y: number, w: number, h: number } {
  const e = sideExtent(geo, placed)
  return { x: e.x0 - SIDE_MARGIN, y: e.y0 - SIDE_MARGIN, w: e.x1 - e.x0 + 2 * SIDE_MARGIN, h: e.y1 - e.y0 + 2 * SIDE_MARGIN }
}

/**
 * Where the two sides sit on the canvas, in world mm: top on the left, bottom on the
 * right, a gap between them, both aligned at y 0.
 */
export function sideFrames(sizes: Record<Side, { w: number, h: number }>): Record<Side, { x: number, y: number, w: number, h: number }> {
  const gap = Math.max(sizes.top.w, sizes.bottom.w) * 0.2
  return {
    top: { x: 0, y: 0, ...sizes.top },
    bottom: { x: sizes.top.w + gap, y: 0, ...sizes.bottom }
  }
}

/** Why a control is off in the 3D view, which has no edit tools. */
export const LOCKED_TITLE = 'The 3D view is for looking: switch back to edit'
/** Why editing is off while the board is not live. */
export const PAUSED_TITLE = 'Reconnecting… editing is paused'
/** Why editing is off on a link that gives view only. */
export const VIEW_TITLE = 'View only: this link lets you look, check and download'
/** Why editing is off on an edit link opened signed out. */
export const SIGN_IN_TITLE = 'Sign in to edit this board'

/** Where to go back to after a sign-in started from a board (sessionStorage key). */
export const RETURN_KEY = 'wirebender:return'

/** A stored return path older than this is ignored (a sign-in abandoned, then done later). */
export const RETURN_TTL_MS = 10 * 60_000

/** What is stored under RETURN_KEY: the path and when it was stored. */
export function returnEntry(path: string, now = Date.now()): string {
  return JSON.stringify({ path, at: now })
}

/**
 * The path in a stored entry if it is a board page of this app (a share link or board id)
 * stored less than RETURN_TTL_MS ago, else null: never another site, never a stale one.
 */
export function returnPath(stored: string | null, now = Date.now()): string | null {
  if (stored === null) return null
  let entry: unknown
  try {
    entry = JSON.parse(stored)
  } catch {
    return null
  }
  const { path, at } = (typeof entry === 'object' && entry !== null ? entry : {}) as { path?: unknown, at?: unknown }
  if (typeof path !== 'string' || typeof at !== 'number' || at > now || now - at >= RETURN_TTL_MS) return null
  return /^\/b\/[\w-]{1,64}$/.test(path) ? path : null
}

/** A control that is off in 3D (or while not live): disabled there with the lock's title, else its own title. */
export function lockedAttrs(locked: boolean, title?: string, lockedTitle = LOCKED_TITLE): { disabled: boolean, title: string | undefined } {
  return { disabled: locked, title: locked ? lockedTitle : title }
}

/** What a page key does: switch the view, step the zoom (0: fit both sides), or toggle the side panel. */
export type KeyAction = { view: View } | { zoom: 1 | -1 | 0 } | { panel: 'toggle' } | null

/**
 * The page's view and zoom keys. `3` toggles the 3D view (off goes back to `last2d`, the 2D
 * view it came from); Esc leaves 3D for both sides; F flips between framing the top and
 * the bottom side. F and the zoom keys do nothing in 3D, where the canvas is not shown.
 * `[` collapses or opens the side panel, in every view. Tool keys (H I P E J) are useTools'.
 */
export function pageKey(key: string, view: View, last2d: Exclude<View, '3d'>): KeyAction {
  if (key === '[') return { panel: 'toggle' }
  if (key === '3') return { view: view === '3d' ? last2d : '3d' }
  if (key === 'Escape') return view === '3d' ? { view: 'both' } : null
  if (view === '3d') return null
  if (key === 'f' || key === 'F') return { view: view === 'top' ? 'bottom' : 'top' }
  if (key === '+' || key === '=') return { zoom: 1 }
  if (key === '-' || key === '_') return { zoom: -1 }
  if (key === '0') return { zoom: 0 }
  return null
}
