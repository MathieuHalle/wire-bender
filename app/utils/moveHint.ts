// The line under the canvas while the Move tool holds something: what is held and the
// keys for it, or why it cannot be set down where it is.
import type { MoveResult } from '~core/move'
import type { Held } from '~/composables/useTools'

const BACK = 'Esc to put back'

/**
 * Null when nothing is held. A flying-wire end (found on the preview's board) has no bend, so
 * no Tab. While `paused` (reconnecting) placing waits, and the hint says so.
 */
export function moveHint(held: Held | null, preview: MoveResult | null, paused = false): string | null {
  if (!held) return null
  const pick = held.pick
  const what = pick.kind === 'part' ? pick.ref : pick.kind === 'wire' ? `wire ${pick.id}` : `the end of wire ${pick.id}`
  if (paused) return `Moving ${what}: reconnecting, placing waits · ${BACK}`
  if (preview?.reason) return `${preview.reason} · ${BACK}`
  if (pick.kind !== 'wire-end') return `Moving ${what}: click to place, R to rotate, ${BACK}`
  const flying = preview?.board.wires.find(w => w.id === pick.id)?.kind === 'flying'
  return flying
    ? `Moving the end of wire ${pick.id}: click to place, ${BACK}`
    : `Moving the end of wire ${pick.id}: click to place, Tab to switch the bend, ${BACK}`
}
