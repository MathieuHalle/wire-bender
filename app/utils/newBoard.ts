// The "New board" form: a preset, or Custom (today's size fields).
import { BOARD_PRESETS, type BoardSides } from '~core/boardPresets'

/** `cols`, `rows` and `type` are the Custom values: a preset never writes over them. */
export interface NewBoardDraft {
  name: string
  /** `custom` or a preset id. */
  preset: string
  cols: number
  rows: number
  type: BoardSides
}

/** The preset menu: Custom first, then the presets in their order. */
export const PRESET_ITEMS: { label: string, value: string }[] = [
  { label: 'Custom', value: 'custom' },
  ...BOARD_PRESETS.map(p => ({ label: p.name, value: p.id }))
]

const presetOf = (d: NewBoardDraft) => BOARD_PRESETS.find(p => p.id === d.preset)

/** What `POST /api/boards` gets: today's body for Custom, else just the preset's id. */
export function newBoardBody(d: NewBoardDraft): { name: string, preset: string } | { name: string, cols: number, rows: number, type: BoardSides } {
  return presetOf(d) ? { name: d.name, preset: d.preset } : { name: d.name, cols: d.cols, rows: d.rows, type: d.type }
}

/** The size the form shows: the preset's (fixed) or the Custom values (editable). */
export function shownSize(d: NewBoardDraft): { cols: number, rows: number, type: BoardSides, fixed: boolean } {
  const p = presetOf(d)
  return p ? { cols: p.cols, rows: p.rows, type: p.type, fixed: true } : { cols: d.cols, rows: d.rows, type: d.type, fixed: false }
}
