// The tool state machine of useTools, against a fake board store (apply/undo/redo/notify).
import { beforeEach, describe, expect, test } from 'vitest'
import { shallowRef } from 'vue'
import { parseHole } from '~core/holes'
import type { BoardFile } from '~core/schema'
import { createTools } from '../../app/composables/useTools'
import { axial, mk, trail } from '../core/helpers'

const h = parseHole

function fakeBoard(start: BoardFile) {
  const board = shallowRef<BoardFile | null>(start)
  const undoStack: BoardFile[] = []
  const redoStack: BoardFile[] = []
  const applied: BoardFile[] = []
  const notes: string[] = []
  const deps = {
    board,
    apply(next: BoardFile) {
      undoStack.push(board.value!)
      redoStack.length = 0
      applied.push(next)
      board.value = next
    },
    undo() {
      const p = undoStack.pop()
      if (!p) return
      redoStack.push(board.value!)
      board.value = p
    },
    redo() {
      const n = redoStack.pop()
      if (!n) return
      undoStack.push(board.value!)
      board.value = n
    },
    notify(reason: string) {
      notes.push(reason)
    }
  }
  return { deps, board, applied, notes }
}

const key = (k: string, extra: Partial<KeyboardEvent> & { target?: unknown } = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, preventDefault() {}, ...extra }) as unknown as KeyboardEvent

/** A key event that records whether preventDefault was called. */
function spyKey(k: string) {
  const ev = {
    prevented: false,
    ...key(k),
    preventDefault() {
      ev.prevented = true
    }
  }
  return ev as typeof ev & KeyboardEvent
}

const laid = (id: string, points: string[], side: 'top' | 'bottom' = 'bottom') =>
  ({ id, kind: 'laid' as const, side, points, bareSegments: [] as number[], joints: [] as string[] })
const flying = (id: string, points: string[], side: 'top' | 'bottom' = 'bottom') =>
  ({ ...laid(id, points, side), kind: 'flying' as const })

let f: ReturnType<typeof fakeBoard>
let t: ReturnType<typeof createTools>
beforeEach(() => {
  f = fakeBoard(mk())
  t = createTools(f.deps)
})

const trails = () => f.board.value!.trails

describe('useTools', () => {
  test('starts on inspect; hole clicks change nothing', () => {
    expect(t.tool.value).toBe('inspect')
    t.onHoleClick('bottom', h('B2'))
    expect(f.applied).toHaveLength(0)
  })

  test('pencil: one apply per click, an L trail, clicking the last hole again ends it without an undo step', () => {
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B2'))
    expect(t.drawing.value).toEqual({ trailId: 'T1', side: 'bottom' })
    t.onHoleClick('bottom', h('B6'))
    t.onHoleClick('bottom', h('E6'))
    expect(f.applied).toHaveLength(3)
    expect(trails()).toEqual([trail('T1', ['B2', 'B6', 'E6'])])
    // A double click on E6: the first click already added it, this one ends the trail.
    t.onHoleClick('bottom', h('E6'))
    expect(t.drawing.value).toBeNull()
    expect(f.applied).toHaveLength(3)
  })

  test('a double click on a hole with another trace ends the trail and starts nothing', () => {
    let clock = 1000
    f = fakeBoard(mk({ trails: [trail('T1', ['E2', 'E8'])] }))
    t = createTools({ ...f.deps, now: () => clock })
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B5'))
    t.onHoleClick('bottom', h('E5')) // over T1: joint, drawing ends
    expect(t.drawing.value).toBeNull()
    clock += 150
    t.onHoleClick('bottom', h('E5'))
    expect(t.drawing.value).toBeNull()
    expect(trails()).toHaveLength(2)
    // Later, a click there starts a trail as usual.
    clock += 1000
    t.onHoleClick('bottom', h('E5'))
    expect(t.drawing.value).toEqual({ trailId: 'T3', side: 'bottom' })
  })

  test('the clicked panel is the side drawn on', () => {
    f = fakeBoard(mk({ board: { type: 'two-sided' } }))
    t = createTools(f.deps)
    t.tool.value = 'pencil'
    t.onHoleClick('top', h('B2'))
    t.onHoleClick('top', h('B4'))
    expect(trails()[0]!.side).toBe('top')
    // A click on the other side ends that drawing and starts one there.
    t.onHoleClick('bottom', h('D2'))
    expect(t.drawing.value).toEqual({ trailId: 'T2', side: 'bottom' })
    expect(trails().map(x => [x.id, x.side, x.points])).toEqual([['T1', 'top', ['B2', 'B4']], ['T2', 'bottom', ['D2']]])
  })

  test('a rejected click (diagonal) notifies the reason and applies nothing', () => {
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B2'))
    const before = f.board.value
    t.onHoleClick('bottom', h('C3'))
    expect(f.notes).toEqual(['Trails run along a row or a column: click a hole in the same row or column.'])
    expect(t.message.value).toBe(f.notes[0])
    expect(f.board.value).toBe(before)
    expect(f.applied).toHaveLength(1)
    expect(t.drawing.value).not.toBeNull()
  })

  test('Esc ends the drawing; a one-point trail is removed', () => {
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B2'))
    t.onKeydown(key('Escape'))
    expect(t.drawing.value).toBeNull()
    expect(trails()).toEqual([])
  })

  test('Esc keeps a trail of two or more points', () => {
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B2'))
    t.onHoleClick('bottom', h('B5'))
    t.onKeydown(key('Escape'))
    expect(t.drawing.value).toBeNull()
    expect(trails()).toEqual([trail('T1', ['B2', 'B5'])])
  })

  test('switching tool ends the drawing', () => {
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B2'))
    t.tool.value = 'erase'
    expect(t.drawing.value).toBeNull()
    expect(trails()).toEqual([])
  })

  test('undo that removes the drawn trail ends the drawing', () => {
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B2'))
    t.onKeydown(key('z', { metaKey: true }))
    expect(trails()).toEqual([])
    expect(t.drawing.value).toBeNull()
  })

  test('erase splits a trail on a segment click; hole clicks are ignored', () => {
    f = fakeBoard(mk({ trails: [trail('T1', ['B2', 'B6'])] }))
    t = createTools(f.deps)
    t.tool.value = 'erase'
    t.onHoleClick('bottom', h('B3'))
    expect(f.applied).toHaveLength(0)
    t.onSegmentClick('bottom', h('B3'), h('B4'))
    expect(trails()).toEqual([trail('T1', ['B2', 'B3']), trail('T2', ['B4', 'B6'])])
    t.onSegmentClick('top', h('B4'), h('B5'))
    expect(f.notes).toHaveLength(1)
    expect(f.applied).toHaveLength(1)
  })

  test('joint toggles a joint, and a miss is a rejection', () => {
    f = fakeBoard(mk({ trails: [trail('T1', ['B2', 'B6'])] }))
    t = createTools(f.deps)
    t.onKeydown(key('j'))
    expect(t.tool.value).toBe('joint')
    t.onHoleClick('bottom', h('B4'))
    expect(trails()[0]!.joints).toEqual(['B4'])
    t.onHoleClick('bottom', h('B4'))
    expect(trails()[0]!.joints).toEqual([])
    t.onHoleClick('bottom', h('H8'))
    expect(f.notes).toEqual(['No trail on this side at H8.'])
    expect(f.applied).toHaveLength(2)
  })

  test('addJoint works whatever the tool', () => {
    f = fakeBoard(mk({ trails: [trail('T1', ['B2', 'B6'])] }))
    t = createTools(f.deps)
    t.addJoint('bottom', h('B3'))
    expect(trails()[0]!.joints).toEqual(['B3'])
  })

  test('keys: H I P E J pick tools, Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z redo', () => {
    for (const [k, tool] of [['h', 'navigate'], ['p', 'pencil'], ['E', 'erase'], ['j', 'joint'], ['H', 'navigate'], ['i', 'inspect']] as const) {
      t.onKeydown(key(k))
      expect(t.tool.value).toBe(tool)
    }
    t.addJoint('bottom', h('B2')) // rejected: no trail, nothing to undo
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B2'))
    t.onHoleClick('bottom', h('B4'))
    t.onKeydown(key('z', { ctrlKey: true }))
    expect(trails()[0]!.points).toEqual(['B2'])
    t.onKeydown(key('Z', { metaKey: true, shiftKey: true }))
    expect(trails()[0]!.points).toEqual(['B2', 'B4'])
    // Cmd+P is the browser's, not ours.
    t.tool.value = 'erase'
    t.onKeydown(key('p', { metaKey: true }))
    expect(t.tool.value).toBe('erase')
  })

  test('keys are ignored while typing in an input', () => {
    const input = { tagName: 'INPUT', isContentEditable: false }
    t.onKeydown(key('p', { target: input }))
    expect(t.tool.value).toBe('inspect')
    t.tool.value = 'pencil'
    t.onHoleClick('bottom', h('B2'))
    t.onKeydown(key('Escape', { target: input }))
    expect(t.drawing.value).not.toBeNull()
    t.onKeydown(key('z', { ctrlKey: true, target: { tagName: 'DIV', isContentEditable: true } }))
    expect(trails()).toHaveLength(1)
  })

  test('locked (the 3D view): no tool keys, no undo, no edits', () => {
    let locked = false
    f = fakeBoard(mk({ trails: [trail('T1', ['B2', 'B6'])] }))
    t = createTools({ ...f.deps, locked: () => locked })
    t.tool.value = 'joint'
    locked = true
    t.onKeydown(key('p'))
    expect(t.tool.value).toBe('joint')
    t.onHoleClick('bottom', h('B4'))
    t.addJoint('bottom', h('B4'))
    expect(f.applied).toHaveLength(0)
    locked = false
    t.addJoint('bottom', h('B4'))
    expect(f.applied).toHaveLength(1)
    locked = true
    t.onKeydown(key('z', { ctrlKey: true }))
    expect(trails()[0]!.joints).toEqual(['B4'])
  })

  test('navigate edits nothing; H picks it in 3D too, but not with a modifier', () => {
    f = fakeBoard(mk({ trails: [trail('T1', ['B2', 'B6'])] }))
    let locked = false
    t = createTools({ ...f.deps, locked: () => locked })
    t.onKeydown(key('h'))
    expect(t.tool.value).toBe('navigate')
    t.onHoleClick('bottom', h('B4'))
    t.onSegmentClick('bottom', h('B2'), h('B3'))
    expect(f.applied).toHaveLength(0)
    expect(t.drawing.value).toBeNull()
    t.tool.value = 'joint'
    locked = true
    t.onKeydown(key('h', { metaKey: true }))
    expect(t.tool.value).toBe('joint')
    t.onKeydown(key('H'))
    expect(t.tool.value).toBe('navigate')
    t.onKeydown(key('h', { target: { tagName: 'INPUT', isContentEditable: false } }))
    expect(t.tool.value).toBe('navigate')
  })
})

describe('the Move tool', () => {
  const at = (s: string) => ({ col: h(s).col, row: h(s).row })
  beforeEach(() => {
    f = fakeBoard(mk({ parts: [axial('R1', 'B2', 'B5', null)], wires: [laid('W1', ['B2', 'B6']), flying('W2', ['H2', 'H9'])] }))
    t = createTools(f.deps)
  })

  test('M picks the Move tool; a click picks up, a second click on the same hole places', () => {
    t.onKeydown(key('M'))
    expect(t.tool.value).toBe('move')
    t.onMoveClick('top', { col: 3, row: 2 })
    expect(t.held.value).toMatchObject({ pick: { kind: 'part', ref: 'R1', at: h('B3') }, side: 'top', target: h('B3'), turns: 0, bend: 'row-first' })
    expect(t.held.value!.snapshot).toBe(JSON.stringify(f.board.value!.parts[0]))
    // Touch: the first tap on another hole previews there, the second places.
    t.onMoveClick('top', { col: 3.2, row: 4.9 })
    expect(t.held.value!.target).toEqual(h('E3'))
    expect(t.preview.value!.reason).toBeNull()
    expect(t.preview.value!.board.parts[0]).toMatchObject({ at: 'E2', to: 'E5' })
    expect(f.applied).toHaveLength(0)
    t.onMoveClick('top', at('E3'))
    expect(f.applied).toHaveLength(1)
    expect(f.board.value!.parts[0]).toMatchObject({ at: 'E2', to: 'E5' })
    expect(t.held.value).toBeNull()
    expect(t.preview.value).toBeNull()
    expect(f.notes).toEqual([])
  })

  test('a click on empty board picks up nothing', () => {
    t.tool.value = 'move'
    t.onMoveClick('top', at('J9'))
    expect(t.held.value).toBeNull()
    // Not in the Move tool: no pick-up.
    t.tool.value = 'inspect'
    t.onMoveClick('top', at('B3'))
    expect(t.held.value).toBeNull()
  })

  test('hover moves the target; the click there places in one apply', () => {
    t.tool.value = 'move'
    t.onMoveClick('bottom', at('B6'))
    expect(t.held.value!.pick).toEqual({ kind: 'wire-end', id: 'W1', end: 'last', at: h('B6') })
    t.onMoveHover('top', h('C8')) // the other side: ignored
    t.onMoveHover('bottom', null) // off the board: the target stays
    expect(t.held.value!.target).toEqual(h('B6'))
    t.onMoveHover('bottom', h('B8'))
    expect(t.held.value!.target).toEqual(h('B8'))
    t.onMoveClick('top', at('B8')) // the other side: nothing
    expect(f.applied).toHaveLength(0)
    t.onMoveClick('bottom', { col: 7.8, row: 2.1 })
    expect(f.applied).toHaveLength(1)
    expect(f.board.value!.wires[0]!.points).toEqual(['B2', 'B8'])
    expect(t.held.value).toBeNull()
  })

  test('R and → turn clockwise, ← counter-clockwise; ignored for a wire end', () => {
    t.tool.value = 'move'
    t.onMoveClick('top', at('B2'))
    t.onKeydown(key('r'))
    expect(t.held.value!.turns).toBe(1)
    t.onKeydown(key('ArrowRight'))
    expect(t.held.value!.turns).toBe(2)
    t.onKeydown(key('ArrowLeft'))
    t.onKeydown(key('ArrowLeft'))
    t.onKeydown(key('ArrowLeft'))
    expect(t.held.value!.turns).toBe(3)
    t.rotate(1)
    expect(t.held.value!.turns).toBe(0)
    t.onKeydown(key('R'))
    expect(t.preview.value!.board.parts[0]).toMatchObject({ at: 'B2', to: 'E2' })
    t.place()
    expect(f.board.value!.parts[0]).toMatchObject({ at: 'B2', to: 'E2' })
    // A whole wire turns too.
    t.onMoveClick('bottom', at('B4'))
    expect(t.held.value!.pick.kind).toBe('wire')
    t.onKeydown(key('r'))
    expect(t.held.value!.turns).toBe(1)
    t.cancel()
    // A wire end does not.
    t.onMoveClick('bottom', at('B2'))
    expect(t.held.value!.pick.kind).toBe('wire-end')
    t.onKeydown(key('r'))
    t.onKeydown(key('ArrowLeft'))
    t.rotate(1)
    expect(t.held.value!.turns).toBe(0)
  })

  test('Tab flips the bend only for a held laid-wire end, and only then prevents default', () => {
    t.tool.value = 'move'
    let ev = spyKey('Tab')
    t.onKeydown(ev)
    expect(ev.prevented).toBe(false)
    // A whole wire: no bend.
    t.onMoveClick('bottom', at('B4'))
    ev = spyKey('Tab')
    t.onKeydown(ev)
    expect(ev.prevented).toBe(false)
    expect(t.held.value!.bend).toBe('row-first')
    t.cancel()
    // A flying wire end: no bend.
    t.onMoveClick('bottom', at('H9'))
    expect(t.held.value!.pick).toMatchObject({ kind: 'wire-end', id: 'W2' })
    ev = spyKey('Tab')
    t.onKeydown(ev)
    expect(ev.prevented).toBe(false)
    expect(t.held.value!.bend).toBe('row-first')
    t.cancel()
    // A laid wire end: Tab switches, and so does switchBend.
    t.onMoveClick('bottom', at('B6'))
    t.onMoveHover('bottom', h('D8'))
    expect(t.preview.value!.board.wires[0]!.points).toEqual(['B2', 'B8', 'D8'])
    ev = spyKey('Tab')
    t.onKeydown(ev)
    expect(ev.prevented).toBe(true)
    expect(t.held.value!.bend).toBe('col-first')
    expect(t.preview.value!.board.wires[0]!.points).toEqual(['B2', 'D2', 'D8'])
    t.switchBend()
    expect(t.held.value!.bend).toBe('row-first')
  })

  test('a refused spot notifies the reason and keeps holding; nothing is applied', () => {
    t.tool.value = 'move'
    t.onMoveClick('top', at('B2'))
    t.onMoveHover('top', h('B8')) // the far lead lands on column 11
    const reason = t.preview.value!.reason
    expect(reason).toEqual(expect.any(String))
    t.onMoveClick('top', at('B8'))
    expect(f.notes).toEqual([reason])
    expect(f.applied).toHaveLength(0)
    expect(t.held.value).not.toBeNull()
    t.place()
    expect(f.notes).toEqual([reason, reason])
    expect(f.applied).toHaveLength(0)
  })

  test('Esc puts it back: no apply, held is null', () => {
    t.tool.value = 'move'
    t.onMoveClick('top', at('B3'))
    t.onMoveHover('top', h('E3'))
    t.onKeydown(key('Escape'))
    expect(t.held.value).toBeNull()
    expect(f.applied).toHaveLength(0)
    expect(t.tool.value).toBe('move')
  })

  test('a remote change to the held item drops it with "<ref> was changed on another device; pick it up again."', () => {
    t.tool.value = 'move'
    t.onMoveClick('top', at('B3'))
    // A change elsewhere keeps the hold.
    f.board.value = { ...f.board.value!, trails: [trail('T1', ['J2', 'J5'])] }
    expect(t.held.value).not.toBeNull()
    f.board.value = { ...f.board.value!, parts: [{ ...f.board.value!.parts[0]!, at: 'C2', to: 'C5' }] }
    expect(t.held.value).toBeNull()
    expect(f.notes).toEqual(['R1 was changed on another device; pick it up again.'])
    // A wire, by its end.
    t.onMoveClick('bottom', at('B6'))
    f.board.value = { ...f.board.value!, wires: [laid('W1', ['B2', 'B7']), flying('W2', ['H2', 'H9'])] }
    expect(t.held.value).toBeNull()
    expect(f.notes[1]).toBe('Wire W1 was changed on another device; pick it up again.')
    expect(f.applied).toHaveLength(0)
  })

  test('a remote deletion of the held item drops it too', () => {
    t.tool.value = 'move'
    t.onMoveClick('bottom', at('B4'))
    expect(t.held.value!.pick).toMatchObject({ kind: 'wire', id: 'W1' })
    f.board.value = { ...f.board.value!, wires: [flying('W2', ['H2', 'H9'])] }
    expect(t.held.value).toBeNull()
    expect(f.notes).toEqual(['Wire W1 was changed on another device; pick it up again.'])
  })

  test('Ctrl/Cmd+Z while holding drops the pick, then undoes', () => {
    t.tool.value = 'move'
    const start = f.board.value
    t.onMoveClick('top', at('B3'))
    t.onMoveClick('top', at('E3'))
    t.onMoveClick('top', at('E3'))
    const moved = f.board.value
    t.onMoveClick('top', at('E3'))
    expect(t.held.value).not.toBeNull()
    t.onKeydown(key('z', { ctrlKey: true }))
    expect(t.held.value).toBeNull()
    expect(f.board.value).toBe(start)
    t.onMoveClick('top', at('B3'))
    t.onKeydown(key('Z', { metaKey: true, shiftKey: true }))
    expect(t.held.value).toBeNull()
    expect(f.board.value).toBe(moved)
    expect(f.notes).toEqual([])
  })

  test('switching tool drops the pick without applying', () => {
    t.tool.value = 'move'
    t.onMoveClick('top', at('B3'))
    t.onMoveHover('top', h('E3'))
    t.onKeydown(key('p'))
    expect(t.tool.value).toBe('pencil')
    expect(t.held.value).toBeNull()
    expect(f.applied).toHaveLength(0)
    expect(f.notes).toEqual([])
  })

  test('locked: no pick-up, and M does not select Move', () => {
    let locked = true
    t = createTools({ ...f.deps, locked: () => locked })
    t.onKeydown(key('m'))
    expect(t.tool.value).toBe('inspect')
    t.tool.value = 'move'
    t.onMoveClick('top', at('B3'))
    expect(t.held.value).toBeNull()
    // Held, then locked: placing applies nothing.
    locked = false
    t.onMoveClick('top', at('B3'))
    t.onMoveHover('top', h('E3'))
    locked = true
    t.place()
    t.onMoveClick('top', at('E3'))
    expect(f.applied).toHaveLength(0)
  })
})
