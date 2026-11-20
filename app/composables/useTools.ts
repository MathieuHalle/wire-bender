// The editing tools: pencil (draw trails), erase (cut a segment), joint (toggle a solder
// joint), move (pick up a part, a wire or a wire end and set it down elsewhere), inspect
// (no edits), navigate (no edits; every left-drag pans the canvas). Every successful click is one `apply`, so one undo step; a
// rejected edit changes nothing and shows its reason. All edits go through core/edit.
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { BoardFile, Side } from '~core/schema'
import { parseHole, type Hole } from '~core/holes'
import { eraseSegment, jumperClick, pencilClick, toggleCut, toggleJoint, type Drawing, type EditResult } from '~core/edit'
import { movePart, moveWire, moveWireEnd, pickAt, type Bend, type MoveResult, type Pick as MovePick, type Turns } from '~core/move'
import { holeExists } from '~core/boardShape'
import { addGridCutout, addMountingHole, addZone, removeFeatureAt, type FeatureEdit, type MountSize } from '~core/editFeatures'
import { isStripboard } from '~core/strips'
import type { Tool } from '~/utils/boardView'
import { stable } from '#shared/yboard'
import type { LiveBoard } from './useLiveBoard'

export interface ToolDeps {
  board: Readonly<Ref<BoardFile | null>>
  /** Writes an edit; the live board refuses it (false) while read-only. */
  apply(next: BoardFile): unknown
  undo(): unknown
  redo(): unknown
  /** Shows a rejection reason (a toast in the app). */
  notify(reason: string): void
  /** Clock in ms (tests pass a fake). */
  now?: () => number
  /** True while editing is off (the 3D view, or a board not live): no edits, no edit-tool keys, no undo (H for Navigate still works). */
  locked?: () => boolean
  /**
   * True while editing is only paused (the live board reconnecting): a lock that keeps what
   * the Move tool holds. Moves are ignored and placing refuses until it is over.
   */
  paused?: () => boolean
  /** True when a side is drawn mirrored: a turn clockwise on screen is counter-clockwise on the board there. */
  mirrored?: (side: Side) => boolean
  /** What a Move click may pick up: the board as drawn (hidden items and layers left out). Placing uses the whole board. */
  pickable?: (board: BoardFile) => BoardFile
}

/** A second click this soon on the hole where a drawing just ended is the rest of a double click. */
const DOUBLE_CLICK_MS = 500

const TOOL_KEYS: Record<string, Tool> = { h: 'navigate', i: 'inspect', p: 'pencil', e: 'erase', j: 'joint', m: 'move', c: 'cut', b: 'block' }

/** What the Move tool holds: the pick, the side it was picked on, where it would land, how it is turned and bent. */
export interface Held {
  pick: MovePick
  side: Side
  target: Hole
  turns: Turns
  bend: Bend
  /** `stable` JSON (sorted keys) of the held part or wire at pick-up: a remote change to it drops the pick. */
  snapshot: string
}

/** The part or wire a pick names, as it is on `board` now (undefined once deleted). */
function pickedItem(board: BoardFile, pick: MovePick): unknown {
  return pick.kind === 'part' ? board.parts.find(p => p.ref === pick.ref) : board.wires.find(w => w.id === pick.id)
}

/** The board with the held item set down at its target (the reason says why not). */
function moveHeld(board: BoardFile, h: Held): MoveResult {
  const { pick, target, turns } = h
  if (pick.kind === 'part') return movePart(board, pick.ref, { from: pick.at, to: target, turns })
  if (pick.kind === 'wire') return moveWire(board, pick.id, { from: pick.at, to: target, turns })
  return moveWireEnd(board, pick.id, pick.end, target, h.bend)
}

/** What the Block tool makes: a no-go zone, a cutout, or a mounting hole. */
export type BlockKind = 'zone' | 'cutout' | 'mount'

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
  const paused = deps.paused ?? (() => false)
  const mirrored = deps.mirrored ?? (() => false)
  const pickable = deps.pickable ?? ((b: BoardFile) => b)
  /** Where and when a pencil click last ended a drawing. */
  let ended: { side: Side, col: number, row: number, at: number } | null = null
  /** What the Move tool holds, if anything. */
  const held = ref<Held | null>(null)
  /** The Block tool's settings (the Edit tab), and the first corner it was given. */
  const blockKind = ref<BlockKind>('zone')
  const blockReason = ref('keep clear')
  const mountSize = ref<MountSize>('M3')
  const blockStart = ref<Hole | null>(null)
  /** The held item at its target, on the board as it is now. */
  const preview: ComputedRef<MoveResult | null> = computed(() => {
    const b = deps.board.value
    const h = held.value
    return b && h ? moveHeld(b, h) : null
  })

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
    if (r.board.trails !== current.trails || r.board.wires !== current.wires || r.board.cuts !== current.cuts) deps.apply(r.board)
    return true
  }

  /** Ends the current drawing. A trail left with a single point is removed (as pencilClick does). */
  function endDrawing() {
    const d = drawing.value
    drawing.value = null
    const b = deps.board.value
    // A jumper is a wire only once it has two points: ending earlier leaves nothing behind.
    if (!d || !b || d.jumper) return
    const t = b.trails.find(x => x.id === d.trailId)
    if (!t || t.points.length !== 1) return
    const r = pencilClick(b, d.side, parseHole(t.points[0]!), d)
    if (r.ok) deps.apply(r.board)
  }

  function onHoleClick(side: Side, hole: Hole) {
    const b = deps.board.value
    if (!b) return
    const breadboard = b.board.type === 'breadboard'
    if (tool.value === 'cut') {
      take(toggleCut(b, hole), b)
      return
    }
    if (tool.value === 'joint') {
      if (!breadboard) take(toggleJoint(b, side, hole), b)
      return
    }
    if (tool.value !== 'pencil') return // inspect, navigate: nothing; erase acts on segments
    if (breadboard) {
      const r = jumperClick(b, hole, drawing.value)
      if (take(r, b)) drawing.value = r.drawing
      return
    }
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

  /** Applies a Block tool edit; says what it did, or why not. */
  function takeFeature(r: FeatureEdit, removed = false) {
    if (locked()) return
    if (!r.ok) {
      message.value = r.reason
      deps.notify(r.reason)
      return
    }
    message.value = null
    if (deps.apply(r.board) !== false && removed) deps.notify(`Removed ${r.what}.`)
  }

  /**
   * Block tool, at a point (fractional hole coordinates): on a feature, takes it away; else a
   * mounting hole goes there, or (zone, cutout) the first click is a corner and the second the other.
   */
  function onBlockPoint(point: { col: number, row: number }) {
    const b = deps.board.value
    if (!b || tool.value !== 'block' || locked()) return
    const p = b.board.pitchMm
    const at = { x: (point.col - 1) * p, y: (point.row - 1) * p }
    const start = blockStart.value
    if (!start) {
      const gone = removeFeatureAt(b, at)
      if (gone) return takeFeature(gone, true)
      if (blockKind.value === 'mount') return takeFeature(addMountingHole(b, at, mountSize.value))
    }
    const hole = { col: Math.round(point.col), row: Math.round(point.row) }
    if (!holeExists(b.board, hole)) return
    if (!start) {
      blockStart.value = hole
      return
    }
    blockStart.value = null
    const reason = blockReason.value.trim() || 'keep clear'
    takeFeature(blockKind.value === 'cutout' ? addGridCutout(b, start, hole, reason) : addZone(b, start, hole, reason))
  }

  /** Applies toggleCut at a hole whatever the tool (the findings panel's "Cut here"). */
  function addCut(hole: Hole) {
    const cur = deps.board.value
    if (cur) take(toggleCut(cur, hole), cur)
  }

  /** Applies toggleJoint at a hole whatever the tool (the findings panel's "Add joint"). */
  function addJoint(side: Side, hole: Hole) {
    const cur = deps.board.value
    if (cur) take(toggleJoint(cur, side, hole), cur)
  }

  /** Move tool: not holding, a click picks up what is there; holding, a click on the target places, elsewhere moves the target. */
  function onMoveClick(side: Side, point: { col: number, row: number }) {
    if (dropIfLocked()) return
    const b = deps.board.value
    if (!b || tool.value !== 'move') return
    const h = held.value
    if (!h) {
      const pick = pickAt(pickable(b), side, point)
      if (!pick) return
      held.value = { pick, side, target: pick.at, turns: 0, bend: 'row-first', snapshot: stable(pickedItem(b, pick)) }
      return
    }
    if (side !== h.side) return
    const hole = { col: Math.round(point.col), row: Math.round(point.row) }
    // Off the board there is no hole to aim at (the hover offers none either): the copy stays put.
    if (!holeExists(b.board, hole)) return
    if (hole.col === h.target.col && hole.row === h.target.row) place()
    else held.value = { ...h, target: hole }
  }

  /** Move tool: the pointer over a hole of the held side moves the target there. */
  function onMoveHover(side: Side, hole: Hole | null) {
    if (dropIfLocked()) return
    const h = held.value
    if (!h || side !== h.side || !hole) return
    if (hole.col !== h.target.col || hole.row !== h.target.row) held.value = { ...h, target: hole }
  }

  /**
   * Turns a held part or whole wire a quarter turn on screen (1 clockwise, -1 counter-clockwise):
   * on a mirrored side that is the other way on the board. A wire end does not turn.
   */
  function rotate(dir: 1 | -1) {
    if (dropIfLocked()) return
    const h = held.value
    if (!h || h.pick.kind === 'wire-end') return
    const cw = (dir === 1) !== mirrored(h.side)
    held.value = { ...h, turns: ((h.turns + (cw ? 1 : 3)) % 4) as Turns }
  }

  /** True when the held thing is one end of a laid wire (the only thing with a bend). */
  function holdsLaidEnd(): boolean {
    const h = held.value
    if (!h || h.pick.kind !== 'wire-end') return false
    const id = h.pick.id
    return deps.board.value?.wires.find(w => w.id === id)?.kind === 'laid'
  }

  /** Switches a held laid-wire end between row first and column first. */
  function switchBend() {
    if (dropIfLocked()) return
    const h = held.value
    if (!h || !holdsLaidEnd()) return
    held.value = { ...h, bend: h.bend === 'row-first' ? 'col-first' : 'row-first' }
  }

  /** Says the held thing cannot be set down while the board is read-only (it stays held). */
  function refuseReadOnly(h: Held) {
    const name = h.pick.kind === 'part' ? h.pick.ref : `wire ${h.pick.id}`
    const reason = `Could not place ${name}: the board is read-only right now.`
    message.value = reason
    deps.notify(reason)
  }

  /** Sets the held thing down at its target, if allowed; otherwise shows why and keeps holding. */
  function place() {
    const h = held.value
    if (h && locked() && paused()) return refuseReadOnly(h)
    if (dropIfLocked()) return
    const r = preview.value
    if (!h || !r) return
    if (r.reason !== null) {
      message.value = r.reason
      deps.notify(r.reason)
      return
    }
    message.value = null
    // Let go first: the apply changes the held item, which is not a remote change.
    held.value = null
    if (deps.apply(r.board) === false) {
      // The live board refused the write (read-only now): keep holding, say why.
      held.value = h
      refuseReadOnly(h)
    }
  }

  /** Puts the held thing back: nothing changes. */
  function cancel() {
    held.value = null
  }

  /**
   * While editing is off nothing may be held: drops the pick quietly. A pause (reconnecting)
   * keeps it: the action is only ignored. True when locked.
   */
  function dropIfLocked(): boolean {
    if (!locked()) return false
    if (!paused()) cancel()
    return true
  }

  function onKeydown(e: KeyboardEvent) {
    if (isTyping(e.target)) return
    const key = e.key.toLowerCase()
    // Putting back changes nothing, so Esc works even while editing is off or paused.
    if (held.value && e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) return cancel()
    // Navigate edits nothing, so it may be picked in 3D too.
    if (dropIfLocked()) {
      if (key === 'h' && !e.metaKey && !e.ctrlKey && !e.altKey) tool.value = 'navigate'
      return
    }
    if ((e.metaKey || e.ctrlKey) && key === 'z') {
      e.preventDefault()
      cancel()
      if (e.shiftKey) deps.redo()
      else deps.undo()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (held.value) {
      const turnable = held.value.pick.kind !== 'wire-end'
      if (e.key === 'Escape') return cancel()
      if (turnable && key === 'r') return rotate(1)
      if (turnable && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        // The arrows would scroll the page.
        e.preventDefault()
        return rotate(e.key === 'ArrowRight' ? 1 : -1)
      }
      if (e.key === 'Tab') {
        if (holdsLaidEnd()) {
          e.preventDefault()
          switchBend()
        }
        return
      }
    }
    if (e.key === 'Escape') {
      endDrawing()
      blockStart.value = null
      return
    }
    const t = TOOL_KEYS[key]
    // A breadboard has no solder: no Joint tool. Only a stripboard has strips to cut.
    if (t === 'joint' && deps.board.value?.board.type === 'breadboard') return
    if (t === 'cut' && !(deps.board.value && isStripboard(deps.board.value.board))) return
    if (t) tool.value = t
  }

  // Switching tool ends the drawing and puts back what Move holds.
  // A first corner belongs to the kind it was given for: changing the kind forgets it.
  watch(blockKind, () => {
    blockStart.value = null
  }, { flush: 'sync' })
  watch(tool, () => {
    endDrawing()
    blockStart.value = null
    cancel()
  }, { flush: 'sync' })
  // Undo, a reload or an outside edit can take the drawn trail away.
  watch(deps.board, (b) => {
    const d = drawing.value
    const gone = d && (d.jumper ? !d.start && !b?.wires.some(w => w.id === d.trailId) : !b?.trails.some(t => t.id === d.trailId))
    if (gone) drawing.value = null
    // Someone else changed or deleted the held item: drop it and say so.
    const h = held.value
    if (!h) return
    const item = b ? pickedItem(b, h.pick) : undefined
    if (item !== undefined && stable(item) === h.snapshot) return
    held.value = null
    if (!b) return
    const name = h.pick.kind === 'part' ? h.pick.ref : `Wire ${h.pick.id}`
    deps.notify(`${name} was changed on another device; pick it up again.`)
  }, { flush: 'sync' })

  return {
    tool, drawing, message, onHoleClick, onSegmentClick, addJoint, addCut, endDrawing, onKeydown,
    held, preview, onMoveClick, onMoveHover, rotate, switchBend, place, cancel,
    blockKind, blockReason, mountSize, blockStart, onBlockPoint
  }
}

/** The tools for the page, on its live board; keys are listened to while mounted. */
export function useTools(
  live: Pick<LiveBoard, 'board' | 'apply' | 'undo' | 'redo'>,
  opts: Pick<ToolDeps, 'locked' | 'paused' | 'mirrored' | 'pickable'> = {}
) {
  const { board, apply, undo, redo } = live
  const warn = useWarning()
  const tools = createTools({
    board,
    apply,
    undo,
    redo,
    locked: opts.locked,
    paused: opts.paused,
    mirrored: opts.mirrored,
    pickable: opts.pickable,
    notify: warn
  })
  onMounted(() => window.addEventListener('keydown', tools.onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', tools.onKeydown))
  return tools
}
