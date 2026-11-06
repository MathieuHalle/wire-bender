// The editing tools: pencil (draw trails), erase (cut a segment), joint (toggle a solder
// joint), inspect (no edits). Every successful click is one `apply`, so one undo step; a
// rejected edit changes nothing and shows its reason. All edits go through core/edit.
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { BoardFile, Side } from '~core/schema'
import { parseHole, type Hole } from '~core/holes'
import { eraseSegment, pencilClick, toggleJoint, type Drawing, type EditResult } from '~core/edit'
import type { Tool } from '~/utils/boardView'
import { useBoard } from './useBoard'

export interface ToolDeps {
  board: Readonly<Ref<BoardFile | null>>
  apply(next: BoardFile): void
  undo(): void
  redo(): void
  /** Shows a rejection reason (a toast in the app). */
  notify(reason: string): void
  /** Clock in ms (tests pass a fake). */
  now?: () => number
  /** True while editing is off (the 3D view): no edits, no tool keys, no undo. */
  locked?: () => boolean
}

/** A second click this soon on the hole where a drawing just ended is the rest of a double click. */
const DOUBLE_CLICK_MS = 500

const TOOL_KEYS: Record<string, Tool> = { i: 'inspect', p: 'pencil', e: 'erase', j: 'joint' }

/** Typing in a field must never trigger a shortcut. */
export function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  if (!t || typeof t !== 'object') return false
  if (t.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName ?? '')
}

/** Exported for tests; the app uses `useTools()`. */
export function createTools(deps: ToolDeps) {
  const tool = ref<Tool>('inspect')
  const drawing = ref<Drawing | null>(null)
  const message = ref<string | null>(null)
  const now = deps.now ?? (() => Date.now())
  const locked = deps.locked ?? (() => false)
  /** Where and when a pencil click last ended a drawing. */
  let ended: { side: Side, col: number, row: number, at: number } | null = null

  /** Applies an ok result (only when it changed the board); returns false on a rejection. */
  function take(r: EditResult, current: BoardFile): r is Extract<EditResult, { ok: true }> {
    if (locked()) return false
    if (!r.ok) {
      message.value = r.reason
      deps.notify(r.reason)
      return false
    }
    message.value = null
    // Ending a drawing on its last hole leaves the trails as they were: no undo step.
    if (r.board.trails !== current.trails) deps.apply(r.board)
    return true
  }

  /** Ends the current drawing. A trail left with a single point is removed (as pencilClick does). */
  function endDrawing() {
    const d = drawing.value
    drawing.value = null
    const b = deps.board.value
    if (!d || !b) return
    const t = b.trails.find(x => x.id === d.trailId)
    if (!t || t.points.length !== 1) return
    const r = pencilClick(b, d.side, parseHole(t.points[0]!), d)
    if (r.ok) deps.apply(r.board)
  }

  function onHoleClick(side: Side, hole: Hole) {
    const b = deps.board.value
    if (!b) return
    if (tool.value === 'joint') {
      take(toggleJoint(b, side, hole), b)
      return
    }
    if (tool.value !== 'pencil') return // inspect: nothing; erase acts on segments
    // The side a click lands on is the side being edited.
    if (drawing.value && drawing.value.side !== side) endDrawing()
    // Double click on a hole that already has a trace: the first click added it and ended
    // the trail; the second must not start a new trail there.
    const e = ended
    ended = null
    if (!drawing.value && e && e.side === side && e.col === hole.col && e.row === hole.row
      && now() - e.at < DOUBLE_CLICK_MS) return
    const cur = deps.board.value!
    const wasDrawing = drawing.value !== null
    const r = pencilClick(cur, side, hole, drawing.value)
    if (!take(r, cur)) return
    drawing.value = r.drawing
    if (wasDrawing && !r.drawing) ended = { side, col: hole.col, row: hole.row, at: now() }
  }

  function onSegmentClick(side: Side, a: Hole, b: Hole) {
    const cur = deps.board.value
    if (!cur || tool.value !== 'erase') return
    take(eraseSegment(cur, side, a, b), cur)
  }

  /** Applies toggleJoint at a hole whatever the tool (the findings panel's "Add joint"). */
  function addJoint(side: Side, hole: Hole) {
    const cur = deps.board.value
    if (cur) take(toggleJoint(cur, side, hole), cur)
  }

  function onKeydown(e: KeyboardEvent) {
    if (isTyping(e.target) || locked()) return
    const key = e.key.toLowerCase()
    if ((e.metaKey || e.ctrlKey) && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) deps.redo()
      else deps.undo()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape') {
      endDrawing()
      return
    }
    const t = TOOL_KEYS[key]
    if (t) tool.value = t
  }

  // Switching tool ends the drawing.
  watch(tool, () => endDrawing(), { flush: 'sync' })
  // Undo, a reload or an outside edit can take the drawn trail away.
  watch(deps.board, (b) => {
    const d = drawing.value
    if (d && !b?.trails.some(t => t.id === d.trailId)) drawing.value = null
  }, { flush: 'sync' })

  return { tool, drawing, message, onHoleClick, onSegmentClick, addJoint, endDrawing, onKeydown }
}

/** The tools for the page, on the shared board; keys are listened to while mounted. */
export function useTools(opts: { locked?: () => boolean } = {}) {
  const { board, apply, undo, redo } = useBoard()
  const toast = useToast()
  const tools = createTools({
    board,
    apply,
    undo,
    redo,
    locked: opts.locked,
    notify: reason => toast.add({ title: reason, color: 'warning', icon: 'i-lucide-ban' })
  })
  onMounted(() => window.addEventListener('keydown', tools.onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', tools.onKeydown))
  return tools
}
