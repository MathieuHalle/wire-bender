import { rowToLetters } from './holes'

/**
 * The numbers printed around a board, as the 2D view and the 3D view both draw them: every
 * column number (1..cols) on the top and bottom edges, every row's letters (A..) on the
 * left and right edges.
 */
export function edgeLabels(cols: number, rows: number): {
  cols: { col: number, text: string }[]
  rows: { row: number, text: string }[]
} {
  return {
    cols: Array.from({ length: cols }, (_, i) => ({ col: i + 1, text: String(i + 1) })),
    rows: Array.from({ length: rows }, (_, i) => ({ row: i + 1, text: rowToLetters(i + 1) }))
  }
}
