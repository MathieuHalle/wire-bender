// Board presets: the boards "New board" and `POST /api/boards` can start from. Each one is an
// ordinary `wirebender/1` board: a size, a pitch, copper sides, and optionally starting parts,
// nets and blocked holes. One list, shared by the app and the server.
import { BENCH_DEFAULTS, type BoardFile, type Part } from './schema'

export type BoardSides = 'one-sided' | 'two-sided'

export interface BoardPreset {
  /** Stable: scripts send it (`{ "name", "preset" }`), so a reworded name breaks nothing. */
  id: string
  name: string
  cols: number
  rows: number
  pitchMm: number
  type: BoardSides
  nets?: BoardFile['nets']
  parts?: Part[]
  /** Holes not to use: mounting holes, cut-outs (`board.blocked`). */
  blocked?: BoardFile['board']['blocked']
}

/** The empty board of that size: no parts, nets or wiring. */
export function blankBoard(name: string, size: { cols: number, rows: number, pitchMm: number, type: BoardSides }): BoardFile {
  return {
    format: 'wirebender/1',
    revision: 0,
    name,
    board: { cols: size.cols, rows: size.rows, pitchMm: size.pitchMm, type: size.type, blocked: [] },
    netClasses: {},
    nets: {},
    rules: { keepAway: [], adjacency: [] },
    parts: [],
    trails: [],
    wires: [],
    legFolds: [],
    solderBridges: [],
    bench: { ...BENCH_DEFAULTS }
  }
}

/** The blank double-sided prototype boards (hole counts from sellers' listings; 4 × 6 cm unconfirmed). */
const proto = (id: string, name: string, cols: number, rows: number): BoardPreset =>
  ({ id, name, cols, rows, pitchMm: 2.54, type: 'two-sided' })

export const BOARD_PRESETS: BoardPreset[] = [
  proto('proto-4x6', 'Prototype board 4 × 6 cm', 14, 20),
  proto('proto-5x7', 'Prototype board 5 × 7 cm', 18, 24),
  proto('proto-7x9', 'Prototype board 7 × 9 cm', 26, 31),
  {
    // The connector's solder tails as a board: pin 1 is +, pin 2 is -. Its real pin spacing is
    // not on the drawing; 2.54 mm keeps the header drawn right.
    id: 'chogori-22004515',
    name: 'CHOGORI 22004515 4-pin connector',
    cols: 2,
    rows: 2,
    pitchMm: 2.54,
    type: 'one-sided',
    nets: { '+': { color: '#d62839' }, '-': { color: '#222222' } },
    parts: [{ ref: 'J1', footprint: 'header-2x2', at: 'A1', rotation: 0, value: 'CHOGORI 22004515-01', pins: { 1: '+', 2: '-', 3: null, 4: null } }]
  }
]

/** Every id `POST /api/boards` accepts as `preset`: `custom` (today's size fields) first. */
export const PRESET_IDS: string[] = ['custom', ...BOARD_PRESETS.map(p => p.id)]

/** A new board named `name` from the preset `id`; null for `custom` (no fixed size) or an unknown id. */
export function presetBoard(id: string, name: string): BoardFile | null {
  const p = BOARD_PRESETS.find(x => x.id === id)
  if (!p) return null
  const b = blankBoard(name, p)
  // A deep copy (the board is plain JSON), so a caller changing its board never changes the list.
  return JSON.parse(JSON.stringify({
    ...b,
    board: { ...b.board, blocked: p.blocked ?? [] },
    nets: p.nets ?? {},
    parts: p.parts ?? []
  })) as BoardFile
}
