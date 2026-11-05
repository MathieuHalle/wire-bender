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
