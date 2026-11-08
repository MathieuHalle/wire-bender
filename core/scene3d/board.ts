import { edgeLabels } from '../edgeLabels'
import { holeMm } from '../holes'
import type { BoardFile } from '../schema'
import { BOARD_THICKNESS_MM, EDGE_MARGIN_PITCH, LABEL_OFFSET_PITCH } from './dims'
import type { EdgeLabel, Scene3D, XZ } from './types'

/**
 * The slab, every drilled hole, the pads and the printed edge numbers. Blocked holes are
 * still drilled and padded.
 */
export function boardGeometry(board: BoardFile): Pick<Scene3D, 'board' | 'holes' | 'pads' | 'labels'> {
  const { cols, rows, pitchMm, type } = board.board
  const holes: XZ[] = []
  for (let row = 1; row <= rows; row++)
    for (let col = 1; col <= cols; col++) {
      const m = holeMm({ col, row }, pitchMm)
      holes.push({ x: m.x, z: m.y })
    }
  // A margin of EDGE_MARGIN_PITCH past the outer holes on every side, wide enough for the
  // printed numbers. It is the same on all four sides, so the centre (and every hole) stays put.
  const margin = EDGE_MARGIN_PITCH * pitchMm
  const widthMm = (cols - 1) * pitchMm + 2 * margin
  const depthMm = (rows - 1) * pitchMm + 2 * margin
  return {
    board: {
      widthMm, depthMm, thicknessMm: BOARD_THICKNESS_MM,
      center: [((cols - 1) * pitchMm) / 2, -BOARD_THICKNESS_MM / 2, ((rows - 1) * pitchMm) / 2]
    },
    holes,
    labels: edgeLabelsMm(cols, rows, pitchMm),
    pads: { top: type === 'two-sided' ? holes.map(h => ({ ...h })) : [], bottom: holes.map(h => ({ ...h })) }
  }
}

/** The 2D view's edge numbering (`edgeLabels`), placed LABEL_OFFSET_PITCH past the outer holes. */
function edgeLabelsMm(cols: number, rows: number, pitchMm: number): EdgeLabel[] {
  const { cols: colLabels, rows: rowLabels } = edgeLabels(cols, rows)
  const off = LABEL_OFFSET_PITCH * pitchMm
  const at = (n: number) => (n - 1) * pitchMm
  return [
    ...colLabels.map(c => ({ text: c.text, edge: 'top' as const, x: at(c.col), z: -off })),
    ...colLabels.map(c => ({ text: c.text, edge: 'bottom' as const, x: at(c.col), z: at(rows) + off })),
    ...rowLabels.map(r => ({ text: r.text, edge: 'left' as const, x: -off, z: at(r.row) })),
    ...rowLabels.map(r => ({ text: r.text, edge: 'right' as const, x: at(cols) + off, z: at(r.row) }))
  ]
}
