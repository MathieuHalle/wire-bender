import { parseBoard, type BoardFile } from '~core/schema'

export type BoardOverrides = Omit<Partial<BoardFile>, 'board'> & { board?: Partial<BoardFile['board']> }

/** A valid 10 x 10 one-sided board with `over` merged in, validated by parseBoard. */
export function mk(over: BoardOverrides = {}): BoardFile {
  const { board, ...rest } = over
  const raw = {
    format: 'wirebender/1', revision: 0, name: 'test',
    board: { cols: 10, rows: 10, pitchMm: 2.54, type: 'one-sided', blocked: [], ...board },
    netClasses: {}, nets: {}, rules: { keepAway: [], adjacency: [] },
    parts: [], trails: [], wires: [], legFolds: [], solderBridges: [],
    ...rest
  }
  const res = parseBoard(raw)
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

export const axial = (ref: string, at: string, to: string, a: string | null, b: string | null = null) =>
  ({ ref, footprint: 'axial', at, to, rotation: 0 as const, pins: { a, b } })
export const trail = (id: string, points: string[], side: 'top' | 'bottom' = 'bottom', joints: string[] = []) =>
  ({ id, side, points, joints })

/**
 * A 400-hole breadboard's `board` settings, as the preset will lay it out (plan Task 9): rails on
 * rows 1, 2, 17 and 18 (25 holes, groups of 5 from column 2), clip strips per column on rows
 * 4–8 (`j`–`f`) and 11–15 (`e`–`a`), the channel on rows 9 and 10.
 */
export function breadboard400(): Partial<BoardFile['board']> {
  const L = (row: number) => String.fromCharCode(64 + row)
  const strips: { from: string, to: string }[] = []
  for (let c = 1; c <= 30; c++) strips.push({ from: `${L(4)}${c}`, to: `${L(8)}${c}` }, { from: `${L(11)}${c}`, to: `${L(15)}${c}` })
  for (const row of [1, 2, 17, 18]) for (let g = 0; g < 5; g++) strips.push({ from: `${L(row)}${2 + g * 6}`, to: `${L(row)}${6 + g * 6}` })
  return {
    cols: 30, rows: 18, type: 'breadboard', shape: { kind: 'strips' }, strips,
    rowLabels: ['+', '-', '', 'j', 'i', 'h', 'g', 'f', '', '', 'e', 'd', 'c', 'b', 'a', '', '-', '+']
  }
}
