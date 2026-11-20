// Board presets: the boards "New board" and `POST /api/boards` can start from. Each one is an
// ordinary `wirebender/1` board: a size, a pitch, copper sides, and optionally starting parts,
// nets and blocked holes. One list, shared by the app and the server.
import { BENCH_DEFAULTS, type BoardFile, type BoardShape, type Part } from './schema'
import { rowToLetters } from './holes'

export type BoardSides = 'one-sided' | 'two-sided'

export interface BoardPreset {
  /** Stable: scripts send it (`{ "name", "preset" }`), so a reworded name breaks nothing. */
  id: string
  name: string
  cols: number
  rows: number
  pitchMm: number
  type: BoardSides | 'breadboard'
  nets?: BoardFile['nets']
  parts?: Part[]
  /** Holes not to use: mounting holes, cut-outs (`board.blocked`). */
  blocked?: BoardFile['board']['blocked']
  /** Round, or with cut corners (`board.shape`); absent for a rectangle. */
  shape?: BoardShape
  /** Copper the board comes with (`board.strips`): a breadboard's clips and rails. */
  strips?: NonNullable<BoardFile['board']['strips']>
  /** Printed row names (`board.rowLabels`). */
  rowLabels?: string[]
}

/** The empty board of that size: no parts, nets or wiring. */
export function blankBoard(name: string, size: { cols: number, rows: number, pitchMm: number, type: BoardSides | 'breadboard', shape?: BoardShape }): BoardFile {
  return {
    format: 'wirebender/1',
    revision: 0,
    name,
    board: { cols: size.cols, rows: size.rows, pitchMm: size.pitchMm, type: size.type, blocked: [], ...(size.shape ? { shape: size.shape } : {}) },
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

const rowName = (row: number) => String.fromCharCode(64 + row)

/**
 * A strip along every row, from column 1 to the last (a stripboard's copper); on a shaped board
 * (`exists`), from the row's first hole to its last, and none on a row with no hole.
 */
export function rowStrips(cols: number, rows: number, exists: (h: { col: number, row: number }) => boolean = () => true): NonNullable<BoardFile['board']['strips']> {
  const out: NonNullable<BoardFile['board']['strips']> = []
  for (let row = 1; row <= rows; row++) {
    const cs = Array.from({ length: cols }, (_, i) => i + 1).filter(col => exists({ col, row }))
    if (cs.length) out.push({ from: `${rowToLetters(row)}${cs[0]}`, to: `${rowToLetters(row)}${cs[cs.length - 1]}` })
  }
  return out
}

/** A Veroboard: one-sided, copper strips along the long side (hole counts from sellers' listings: unconfirmed). */
const stripboard = (id: string, name: string, cols: number, rows: number): BoardPreset =>
  ({ id, name, cols, rows, pitchMm: 2.54, type: 'one-sided', strips: rowStrips(cols, rows) })

/**
 * A solderless breadboard (layouts from sellers' drawings: to confirm on a real board). Clip
 * strips of 5 per column, `j`–`f` above the channel and `e`–`a` below it (row `a` at the bottom, as
 * on most prints). With rails: `+` and `-` on the two outer rows of each edge, groups of 5 with
 * one hole skipped between groups, centred on the columns; `split` breaks each rail in the middle.
 */
function breadboard(id: string, name: string, cols: number, rails: 'none' | 'full' | 'split'): BoardPreset {
  const withRails = rails !== 'none'
  // Rows: [+, -, gap] j f [channel, channel] e a [gap, -, +]
  const top = withRails ? 3 : 0
  const upper = top + 1 // j
  const lower = upper + 7 // e: 5 clip rows, then the 2-row channel
  const rows = lower + 4 + (withRails ? 3 : 0)
  const strips: NonNullable<BoardFile['board']['strips']> = []
  for (let c = 1; c <= cols; c++)
    strips.push({ from: `${rowName(upper)}${c}`, to: `${rowName(upper + 4)}${c}` }, { from: `${rowName(lower)}${c}`, to: `${rowName(lower + 4)}${c}` })
  const labels = [...'jihgf'.split(''), '', '', ...'edcba'.split('')]
  let rowLabels = labels
  if (withRails) {
    // Groups of 5 with one gap between: 5g + (g - 1) places, centred on the columns.
    const groups = Math.floor((cols + 1) / 6)
    const places = groups * 6 - 1
    const first = Math.ceil((cols - places) / 2) + 1
    const gaps = Array.from({ length: groups - 1 }, (_, i) => first + 5 + i * 6)
    for (const row of [1, 2, rows - 1, rows]) {
      const name = (c: number) => `${rowName(row)}${c}`
      if (rails === 'split') {
        const mid = gaps[Math.floor(gaps.length / 2)]!
        const left = gaps.filter(g => g < mid)
        const right = gaps.filter(g => g > mid)
        strips.push({ from: name(first), to: name(mid - 1), skip: left.map(name) })
        strips.push({ from: name(mid + 1), to: name(first + places - 1), skip: right.map(name) })
      } else strips.push({ from: name(first), to: name(first + places - 1), skip: gaps.map(name) })
    }
    rowLabels = ['+', '-', '', ...labels, '', '-', '+']
  }
  return { id, name, cols, rows, pitchMm: 2.54, type: 'breadboard', shape: { kind: 'strips' }, strips, rowLabels }
}

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
    // Round, like the connector; its four holes all stay.
    shape: { kind: 'round' },
    nets: { '+': { color: '#d62839' }, '-': { color: '#222222' } },
    parts: [{ ref: 'J1', footprint: 'header-2x2', at: 'A1', rotation: 0, value: 'CHOGORI 22004515-01', pins: { 1: '+', 2: '-', 3: null, 4: null } }]
  },
  breadboard('bb-830', 'Breadboard 830 (split rails)', 63, 'split'),
  breadboard('bb-830-full', 'Breadboard 830', 63, 'full'),
  breadboard('bb-400', 'Breadboard 400', 30, 'full'),
  breadboard('bb-170', 'Breadboard 170', 17, 'none'),
  stripboard('vero-95x127', 'Stripboard (Veroboard) 95 × 127 mm', 50, 36),
  stripboard('vero-64x95', 'Stripboard (Veroboard) 64 × 95 mm', 37, 24)
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
    board: { ...b.board, blocked: p.blocked ?? [], ...(p.strips ? { strips: p.strips } : {}), ...(p.rowLabels ? { rowLabels: p.rowLabels } : {}) },
    nets: p.nets ?? {},
    parts: p.parts ?? []
  })) as BoardFile
}
