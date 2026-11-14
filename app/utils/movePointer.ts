// Only a mouse moves the Move tool's target by hovering. A finger's jiggle (or a pen
// hovering) would set the target under the tap, and the tap would then place at once
// without the copy ever being seen there: on touch a tap previews, Place sets.

/** Whether a hover by this pointer (`PointerEvent.pointerType`, null when none seen yet) moves the target. */
export function hoverMovesTarget(pointerType: string | null | undefined): boolean {
  return pointerType === 'mouse'
}
