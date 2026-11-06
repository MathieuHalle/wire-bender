import { holeMm } from '../holes'
import type { BoardFile } from '../schema'
import { BOARD_THICKNESS_MM } from './dims'
import type { Scene3D, XZ } from './types'

/** The slab, every drilled hole and the pads. Blocked holes are still drilled and padded. */
export function boardGeometry(board: BoardFile): Pick<Scene3D, 'board' | 'holes' | 'pads'> {
  const { cols, rows, pitchMm, type } = board.board
  const holes: XZ[] = []
  for (let row = 1; row <= rows; row++)
    for (let col = 1; col <= cols; col++) {
      const m = holeMm({ col, row }, pitchMm)
      holes.push({ x: m.x, z: m.y })
    }
  // Margin past the outer holes is half a pitch on each side.
  const widthMm = (cols - 1) * pitchMm + pitchMm
  const depthMm = (rows - 1) * pitchMm + pitchMm
  return {
    board: {
      widthMm, depthMm, thicknessMm: BOARD_THICKNESS_MM,
      center: [((cols - 1) * pitchMm) / 2, -BOARD_THICKNESS_MM / 2, ((rows - 1) * pitchMm) / 2]
    },
    holes,
    pads: { top: type === 'two-sided' ? holes.map(h => ({ ...h })) : [], bottom: holes.map(h => ({ ...h })) }
  }
}
