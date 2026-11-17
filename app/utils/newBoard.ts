// The "New board" form: a preset, or Custom (size, copper sides and shape).
import { BOARD_PRESETS, type BoardSides } from '~core/boardPresets'
import type { BoardShape, CornerCut } from '~core/schema'

/** The form's shapes: corner cuts apply to all four corners. */
export type ShapeChoice = 'rect' | 'round' | 'chamfer' | 'notch'

/** `cols`, `rows`, `type`, `shape` and `cornerHoles` are the Custom values: a preset never writes over them. */
export interface NewBoardDraft {
  name: string
  /** `custom` or a preset id. */
  preset: string
  cols: number
  rows: number
  type: BoardSides
  shape: ShapeChoice
  /** How deep the corner cuts go, in holes (chamfer, notch). */
  cornerHoles: number
}

export const SHAPE_ITEMS: { label: string, value: ShapeChoice }[] = [
  { label: 'Rectangle', value: 'rect' },
  { label: 'Round', value: 'round' },
  { label: 'Chamfered corners', value: 'chamfer' },
  { label: 'Notched corners', value: 'notch' }
]

/** The board file's `shape` for a Custom draft (none for a rectangle). */
function shapeOf(d: NewBoardDraft): BoardShape | undefined {
  if (d.shape === 'rect') return undefined
  if (d.shape === 'round') return { kind: 'round' }
  const cut: CornerCut = { cut: d.shape, holes: d.cornerHoles }
  return { kind: 'corners', corners: { topLeft: cut, topRight: cut, bottomLeft: cut, bottomRight: cut } }
}

/** A preset's shape, as the form's menu names it. */
function choiceOf(shape: BoardShape | undefined): ShapeChoice {
  if (!shape) return 'rect'
  if (shape.kind === 'round') return 'round'
  return Object.values(shape.corners)[0]?.cut ?? 'rect'
}

/** The preset menu: Custom first, then the presets in their order. */
export const PRESET_ITEMS: { label: string, value: string }[] = [
  { label: 'Custom', value: 'custom' },
  ...BOARD_PRESETS.map(p => ({ label: p.name, value: p.id }))
]

const presetOf = (d: NewBoardDraft) => BOARD_PRESETS.find(p => p.id === d.preset)

/** What `POST /api/boards` gets: today's body for Custom (with its shape, if not a rectangle), else just the preset's id. */
export function newBoardBody(d: NewBoardDraft): { name: string, preset: string } | { name: string, cols: number, rows: number, type: BoardSides, shape?: BoardShape } {
  if (presetOf(d)) return { name: d.name, preset: d.preset }
  const shape = shapeOf(d)
  return { name: d.name, cols: d.cols, rows: d.rows, type: d.type, ...(shape ? { shape } : {}) }
}

/** What the form shows: the preset's size and shape (fixed) or the Custom values (editable). */
export function shownSize(d: NewBoardDraft): { cols: number, rows: number, type: BoardSides, shape: ShapeChoice, fixed: boolean } {
  const p = presetOf(d)
  return p
    ? { cols: p.cols, rows: p.rows, type: p.type, shape: choiceOf(p.shape), fixed: true }
    : { cols: d.cols, rows: d.rows, type: d.type, shape: d.shape, fixed: false }
}
