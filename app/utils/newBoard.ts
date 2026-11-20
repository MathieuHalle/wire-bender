// The "New board" form: a preset, or Custom (size, copper sides and shape).
import { BOARD_PRESETS, type BoardSides } from '~core/boardPresets'
import type { BoardShape, CornerCut } from '~core/schema'

/** The form's shapes: corner cuts apply to all four corners. */
export type ShapeChoice = 'rect' | 'round' | 'chamfer' | 'notch'

/**
 * `cols`, `rows`, `type`, `shape` and `cornerHoles` are the Custom values: a preset never writes
 * over them. A number field left empty is null and is sent as it is: the server says what is wrong.
 */
export interface NewBoardDraft {
  name: string
  /** `custom` or a preset id. */
  preset: string
  cols: number | null
  rows: number | null
  type: BoardSides
  shape: ShapeChoice
  /** How deep the corner cuts go, in holes (chamfer, notch). */
  cornerHoles: number | null
  /** Pads at every hole (a perfboard), or a copper strip along every row (a stripboard). Absent: pads. */
  copper?: Copper
}

export type Copper = 'pads' | 'strips'
export const COPPER_ITEMS: { label: string, value: Copper }[] = [
  { label: 'Pads (perfboard)', value: 'pads' },
  { label: 'Strips (stripboard)', value: 'strips' }
]

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
  // An empty corner size goes as null: the server refuses it with its own message.
  const cut = { cut: d.shape, holes: d.cornerHoles } as CornerCut
  return { kind: 'corners', corners: { topLeft: cut, topRight: cut, bottomLeft: cut, bottomRight: cut } }
}

/** A preset's shape, as the form's menu names it. */
function choiceOf(shape: BoardShape | undefined): ShapeChoice {
  if (!shape) return 'rect'
  if (shape.kind === 'round') return 'round'
  if (shape.kind === 'strips') return 'rect' // a breadboard: its gaps are strips, the outline a rectangle
  return Object.values(shape.corners)[0]?.cut ?? 'rect'
}

/** The preset menu: Custom first, then the presets in their order. */
export const PRESET_ITEMS: { label: string, value: string }[] = [
  { label: 'Custom', value: 'custom' },
  ...BOARD_PRESETS.map(p => ({ label: p.name, value: p.id }))
]

const presetOf = (d: NewBoardDraft) => BOARD_PRESETS.find(p => p.id === d.preset)

/** What `POST /api/boards` gets: today's body for Custom (with its shape, if not a rectangle), else just the preset's id. */
export function newBoardBody(d: NewBoardDraft): { name: string, preset: string } | { name: string, cols: number | null, rows: number | null, type: BoardSides, shape?: BoardShape, copper?: 'strips' } {
  if (presetOf(d)) return { name: d.name, preset: d.preset }
  const shape = shapeOf(d)
  return { name: d.name, cols: d.cols, rows: d.rows, type: d.type, ...(shape ? { shape } : {}), ...(d.copper === 'strips' ? { copper: 'strips' as const } : {}) }
}

/** What the form shows: the preset's size and shape (fixed) or the Custom values (editable). */
export function shownSize(d: NewBoardDraft): { cols: number | null, rows: number | null, type: BoardSides | 'breadboard', shape: ShapeChoice, copper: Copper, fixed: boolean } {
  const p = presetOf(d)
  return p
    ? { cols: p.cols, rows: p.rows, type: p.type, shape: choiceOf(p.shape), copper: p.strips && p.type !== 'breadboard' ? 'strips' : 'pads', fixed: true }
    : { cols: d.cols, rows: d.rows, type: d.type, shape: d.shape, copper: d.copper ?? 'pads', fixed: false }
}
