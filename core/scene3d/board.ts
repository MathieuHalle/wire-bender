import { edgeLabels } from '../edgeLabels'
import { holeMm } from '../holes'
import { boardRectMm, existingHoles, outlinePoints, rectGrown } from '../boardShape'
import { cutoutShape, mountingShapes, type FeatureShape } from '../features'
import type { BoardFile } from '../schema'
import { BOARD_THICKNESS_MM, BREADBOARD_THICKNESS_MM, COLORS, EDGE_MARGIN_PITCH, LABEL_OFFSET_PITCH } from './dims'
import type { EdgeLabel, Scene3D, XZ } from './types'

/**
 * The slab, every drilled hole, the pads and the printed edge numbers. Blocked holes are
 * still drilled and padded. A breadboard is an ivory block, its top at y = 0 like a board's,
 * with no pads (nothing is soldered) and square holes on the top.
 */
export function boardGeometry(board: BoardFile): Pick<Scene3D, 'board' | 'holes' | 'pads' | 'labels'> {
  const { pitchMm, type } = board.board
  // Only the holes the board has (a round or cut board has fewer).
  const holes: XZ[] = existingHoles(board.board).map((h) => {
    const m = holeMm(h, pitchMm)
    return { x: m.x, z: m.y }
  })
  // A margin of EDGE_MARGIN_PITCH past the outer holes on every side, wide enough for the
  // printed numbers on a rectangle. It is the same on all four sides, so the centre (and every
  // hole) stays put.
  const breadboard = type === 'breadboard'
  const thicknessMm = breadboard ? BREADBOARD_THICKNESS_MM : BOARD_THICKNESS_MM
  // Grown round a mounting hole beyond the margin (`boardRectMm`); otherwise the margin on every
  // side, computed as it always was (so a plain board's scene is unchanged to the last digit).
  const grown = rectGrown(board.board, EDGE_MARGIN_PITCH)
  const margin = EDGE_MARGIN_PITCH * pitchMm
  const r = grown ? boardRectMm(board.board, EDGE_MARGIN_PITCH) : null
  const widthMm = r ? r.x1 - r.x0 : (board.board.cols - 1) * pitchMm + 2 * margin
  const depthMm = r ? r.y1 - r.y0 : (board.board.rows - 1) * pitchMm + 2 * margin
  const openings = featureOutlines(board.board)
  return {
    board: {
      widthMm, depthMm, thicknessMm,
      center: r
        ? [(r.x0 + r.x1) / 2, -thicknessMm / 2, (r.y0 + r.y1) / 2]
        : [((board.board.cols - 1) * pitchMm) / 2, -thicknessMm / 2, ((board.board.rows - 1) * pitchMm) / 2],
      pitchMm,
      ...(breadboard ? { look: { color: COLORS.breadboard, print: COLORS.breadboardPrint, squareHoles: true as const } } : {}),
      // The same margin as the box. The numbers stay on the bounding rectangle, so on a round
      // board, and beside a cut corner, they print off the board (a design call).
      ...(board.board.shape ? { outline: outlinePoints(board.board, EDGE_MARGIN_PITCH).map(p => ({ x: p.x, z: p.y })) } : {}),
      ...(openings.length ? { openings } : {})
    },
    holes,
    labels: edgeLabelsMm(board.board),
    pads: { top: type === 'two-sided' ? holes.map(h => ({ ...h })) : [], bottom: breadboard ? [] : holes.map(h => ({ ...h })) }
  }
}

/** Cutouts and drilled mounting holes as closed x/z outlines (a circle in 48 points). */
function featureOutlines(b: BoardFile['board']): XZ[][] {
  const poly = (s: FeatureShape): XZ[] => s.kind === 'rect'
    ? [{ x: s.x0, z: s.y0 }, { x: s.x1, z: s.y0 }, { x: s.x1, z: s.y1 }, { x: s.x0, z: s.y1 }]
    : Array.from({ length: 48 }, (_, i) => ({ x: s.cx + s.r * Math.cos((i / 48) * 2 * Math.PI), z: s.cy + s.r * Math.sin((i / 48) * 2 * Math.PI) }))
  return [...(b.cutouts ?? []).map(c => poly(cutoutShape(b, c))), ...(b.mountingHoles ?? []).map(m => poly(mountingShapes(m).hole))]
}

/** The 2D view's edge numbering (`edgeLabels`), placed LABEL_OFFSET_PITCH past the outer holes. */
function edgeLabelsMm(b: BoardFile['board']): EdgeLabel[] {
  const { cols, rows, pitchMm } = b
  const { cols: colLabels, rows: rowLabels } = edgeLabels(b)
  const off = LABEL_OFFSET_PITCH * pitchMm
  const at = (n: number) => (n - 1) * pitchMm
  return [
    ...colLabels.map(c => ({ text: c.text, edge: 'top' as const, x: at(c.col), z: -off })),
    ...colLabels.map(c => ({ text: c.text, edge: 'bottom' as const, x: at(c.col), z: at(rows) + off })),
    ...rowLabels.map(r => ({ text: r.text, edge: 'left' as const, x: -off, z: at(r.row) })),
    ...rowLabels.map(r => ({ text: r.text, edge: 'right' as const, x: at(cols) + off, z: at(r.row) }))
  ]
}
