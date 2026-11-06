// View helpers for the board drawing: geometry (mm, optionally mirrored), net colours,
// and lit sets for a highlighted group. Pure functions over core/ results (which group
// sits at a hole is core's `groupAtHole`).
import { holeKey, holeMm, type Hole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import type { Conductor, Connectivity } from '~core/connectivity'

export type Tool = 'inspect' | 'pencil' | 'erase' | 'joint'
/** Both sides side by side, one large side, or the 3D view. */
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
  const pitch = board.board.pitchMm
  const span = (board.board.cols - 1) * pitch
  const x = (v: number) => (mirrored ? span - v : v)
  return {
    pitch,
    cols: board.board.cols,
    rows: board.board.rows,
    span,
    mirrored,
    x,
    pt(h) {
      const m = holeMm(h, pitch)
      return { x: x(m.x), y: m.y }
    },
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

/** Zoom levels of the 2D preview; 1 fits the width, below 1 the board is centred smaller. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6] as const

/** The next zoom level up (dir 1) or down (dir -1) from `z`, clamped to the steps. */
export function zoomStep(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find(s => s > z + 1e-9) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  return [...ZOOM_STEPS].reverse().find(s => s < z - 1e-9) ?? ZOOM_STEPS[0]
}

/** Why a control is off in the 3D view, which has no edit tools. */
export const LOCKED_TITLE = 'The 3D view is for looking: switch back to edit'

/** A control that is off in 3D: disabled there with LOCKED_TITLE, else its own title. */
export function lockedAttrs(locked: boolean, title?: string): { disabled: boolean, title: string | undefined } {
  return { disabled: locked, title: locked ? LOCKED_TITLE : title }
}

/** What a page key does: switch the view, step the zoom (0: back to fit), or toggle the side panel. */
export type KeyAction = { view: View } | { zoom: 1 | -1 | 0 } | { panel: 'toggle' } | null

/**
 * The page's view and zoom keys. `3` toggles the 3D view (off goes back to `last2d`, the 2D
 * view it came from); Esc leaves 3D for both sides; F flips one large side. F and the zoom
 * keys do nothing in 3D, where the drawing is not shown. `[` collapses or opens the side
 * panel, in every view.
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
