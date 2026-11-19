// Strips in the 3D scene: a stripboard's copper bands on the bottom, and a breadboard's print on
// its top (the channel, the red and blue rail lines). Pure: no Node, DOM or three.js.
import { parseHole } from '../holes'
import type { BoardFile } from '../schema'
import { BOARD_BOTTOM_Y, COLORS, COPPER_THICKNESS_MM } from './dims'
import type { Prim, Tag } from './types'

const BOARD_TAG: Tag = { kind: 'board', id: 'board' }
/** Print and stripes sit this far over the top surface, so they don't z-fight with it. */
const PRINT_Y = 0.02

/** One copper band per strip under its holes, on the bottom of a stripboard. */
export function stripBandPrims(board: BoardFile): Prim[] {
  if (board.board.type === 'breadboard') return []
  const p = board.board.pitchMm
  const w = p * 0.84
  return (board.board.strips ?? []).map((s) => {
    const a = parseHole(s.from)
    const b = parseHole(s.to)
    const x0 = (Math.min(a.col, b.col) - 1) * p
    const x1 = (Math.max(a.col, b.col) - 1) * p
    const z0 = (Math.min(a.row, b.row) - 1) * p
    const z1 = (Math.max(a.row, b.row) - 1) * p
    return {
      kind: 'box', center: [(x0 + x1) / 2, BOARD_BOTTOM_Y - COPPER_THICKNESS_MM / 2, (z0 + z1) / 2],
      size: [x1 - x0 + w, COPPER_THICKNESS_MM, z1 - z0 + w], color: COLORS.copper, metal: true,
      tag: { kind: 'board', id: 'board', label: `strip ${s.from}–${s.to}` }
    } satisfies Prim
  })
}

/** A breadboard's print: the channel between rows `e` and `f`, and a line beside each rail. */
export function breadboardPrims(board: BoardFile): Prim[] {
  if (board.board.type !== 'breadboard') return []
  const { pitchMm: p, cols, rowLabels = [] } = board.board
  const out: Prim[] = []
  const x0 = -p / 2
  const x1 = (cols - 1) * p + p / 2
  const re = rowLabels.indexOf('e') + 1
  const rf = rowLabels.indexOf('f') + 1
  if (re && rf && Math.abs(re - rf) >= 2) {
    const z0 = (Math.min(re, rf) - 1) * p + p * 0.75
    const z1 = (Math.max(re, rf) - 1) * p - p * 0.75
    out.push({ kind: 'box', center: [(x0 + x1) / 2, PRINT_Y / 2, (z0 + z1) / 2], size: [x1 - x0, PRINT_Y, Math.max(z1 - z0, p * 0.4)], color: COLORS.channel, tag: BOARD_TAG })
  }
  const sign = (row: number) => (rowLabels[row - 1] === '+' || rowLabels[row - 1] === '-' ? rowLabels[row - 1] : null)
  for (const s of board.board.strips ?? []) {
    const a = parseHole(s.from)
    const b = parseHole(s.to)
    const sg = sign(a.row)
    if (a.row !== b.row || !sg) continue
    const away = sign(a.row - 1) ? 1 : sign(a.row + 1) ? -1 : a.row <= board.board.rows / 2 ? -1 : 1
    const z = (a.row - 1 + away * 0.6) * p
    const xa = (Math.min(a.col, b.col) - 1) * p - p / 2
    const xb = (Math.max(a.col, b.col) - 1) * p + p / 2
    out.push({
      kind: 'box', center: [(xa + xb) / 2, PRINT_Y, z], size: [xb - xa, PRINT_Y, 0.3],
      color: sg === '+' ? COLORS.railPlus : COLORS.railMinus, tag: BOARD_TAG
    })
  }
  return out
}
