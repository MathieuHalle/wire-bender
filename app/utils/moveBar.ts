// The Move tool's bar of buttons on a touch screen (no hover, no keys), while something is held.
import type { BoardFile } from '~core/schema'
import type { MoveResult } from '~core/move'
import type { Held } from '../composables/useTools'

export interface MoveBar {
  /** Rotate: a part or a whole wire. */
  rotate: boolean
  /** Switch bend: one end of a laid wire. */
  bend: boolean
  /** The spot is allowed. */
  canPlace: boolean
  /** Reconnecting: Rotate, Switch bend and Place do nothing, so they show disabled. Cancel works. */
  paused: boolean
}

/** The bar for what is held, or null when there is none (no touch screen, nothing held, editing off). */
export function moveBar(opts: {
  coarse: boolean
  held: Held | null
  preview: MoveResult | null
  lockedTitle: string | null
  pausedTitle: string
  board: BoardFile | null
}): MoveBar | null {
  const { coarse, held, preview, lockedTitle, pausedTitle, board } = opts
  const paused = lockedTitle === pausedTitle
  if (!coarse || !held || (lockedTitle && !paused)) return null
  const pick = held.pick
  const end = pick.kind === 'wire-end'
  return {
    rotate: !end,
    bend: end && board?.wires.find(w => w.id === pick.id)?.kind === 'laid',
    canPlace: preview?.reason === null,
    paused
  }
}
