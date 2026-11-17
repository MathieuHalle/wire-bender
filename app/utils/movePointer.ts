import type { Hole } from '~core/holes'

// Only a mouse moves the Move tool's target by hovering. A finger's jiggle (or a pen
// hovering) would set the target under the tap, and the tap would then place at once
// without the copy ever being seen there: on touch a tap previews, Place sets.

/** Whether a hover by this pointer (`PointerEvent.pointerType`, null when none seen yet) moves the target. */
export function hoverMovesTarget(pointerType: string | null | undefined): boolean {
  return pointerType === 'mouse'
}

/**
 * The hole under the board point (fc, fr) (fractional column and row, holes at whole numbers), or
 * null off the board. Normally only within half a pitch of a hole: the gaps between holes have
 * none. With `snapAll` (the Move tool) every point snaps to the hole a click there rounds to, so
 * the copy the hover shows is the one the click places.
 */
export function hoverHole(fc: number, fr: number, exists: (h: Hole) => boolean, snapAll: boolean): Hole | null {
  const h = { col: Math.round(fc), row: Math.round(fr) }
  // Off the board, or a hole its shape removed (`holeExists`).
  if (!exists(h)) return null
  if (!snapAll && Math.hypot(fc - h.col, fr - h.row) > 0.5) return null
  return h
}
