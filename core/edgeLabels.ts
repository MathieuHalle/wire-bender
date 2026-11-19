import { rowToLetters } from './holes'
import type { BoardFile } from './schema'

/**
 * The numbers printed around a board, as the 2D view and the 3D view both draw them: column
 * numbers on the top and bottom edges, row letters on the left and right edges. Every column and
 * every row (A..), unless the board has printed row names (`rowLabels`): then those, and none
 * for a row whose label is `""`. A breadboard numbers its columns like its print: 1, 5, 10, …
 */
export function edgeLabels(b: Pick<BoardFile['board'], 'cols' | 'rows'> & Partial<Pick<BoardFile['board'], 'type' | 'rowLabels'>>): {
  cols: { col: number, text: string }[]
  rows: { row: number, text: string }[]
} {
  const every = Array.from({ length: b.cols }, (_, i) => i + 1)
  const cols = b.type === 'breadboard' ? every.filter(c => c === 1 || c % 5 === 0) : every
  const rows = Array.from({ length: b.rows }, (_, i) => ({ row: i + 1, text: b.rowLabels ? b.rowLabels[i] ?? '' : rowToLetters(i + 1) }))
  return {
    cols: cols.map(col => ({ col, text: String(col) })),
    rows: rows.filter(r => r.text !== '')
  }
}
