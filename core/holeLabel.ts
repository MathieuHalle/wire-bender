// Printed names: a board with `rowLabels` (a breadboard) shows the names on its print, `a12`,
// while files, the API and the MCP keep grid names, `D12`. Display only: everything that is
// looked up (finding holes, card ends) stays a grid name.
import { holeName, parseHole, type Hole } from './holes'
import type { BoardFile } from './schema'

type Board = BoardFile['board']

/** The row's printed label, or null when the board has none for it (no labels, or `""`). */
function rowLabel(b: Board, row: number): string | null {
  const l = b.rowLabels?.[row - 1]
  return l ? l : null
}

/** True when another row prints the same label (both pairs of rails print `+` and `-`). */
function repeated(b: Board, row: number): boolean {
  const l = rowLabel(b, row)
  return l !== null && b.rowLabels!.filter(x => x === l).length > 1
}

/** The name on the print, `a12`; the grid name where the row has no label. */
function printedOnly(b: Board, h: Hole): string {
  const l = rowLabel(b, h.row)
  return l === null ? holeName(h) : `${l}${h.col}`
}

/**
 * For messages: `a12 (D12)` where the print names the row, else `D12`. Both, so a finding can be
 * read on the board and found in the file.
 */
export function holeLabel(b: Board, h: Hole): string {
  return rowLabel(b, h.row) === null ? holeName(h) : `${printedOnly(b, h)} (${holeName(h)})`
}

/**
 * For the drawing and the bench sheet: `a12` alone, where it names one hole; a repeated label
 * keeps its grid name (`+3 (A3)`), and a row without one is its grid name.
 */
export function printedName(b: Board, h: Hole): string {
  return repeated(b, h.row) ? holeLabel(b, h) : printedOnly(b, h)
}

/** "strip j5–f5 (D5–H5)" for a strip conductor id (`D5-H5`); "strip D5–H5" without labels. */
export function stripLabel(b: Board, id: string): string {
  const [from, to] = id.split('-') as [string, string]
  const grid = `${from}–${to}`
  const a = parseHole(from)
  const c = parseHole(to)
  if (rowLabel(b, a.row) === null && rowLabel(b, c.row) === null) return `strip ${grid}`
  return `strip ${printedOnly(b, a)}–${printedOnly(b, c)} (${grid})`
}
