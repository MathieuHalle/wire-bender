import { describe, expect, it } from 'vitest'
import { undoState } from '#shared/undoState'

describe('undoState', () => {
  it('replays edit, edit, undo, undo, redo', () => {
    const revs = [
      { n: 1, how: 'create', target: null },
      { n: 2, how: 'edit', target: null },
      { n: 3, how: 'edit', target: null }
    ]
    expect(undoState(revs)).toEqual({ undo: 3, redo: null })
    revs.push({ n: 4, how: 'undo', target: 3 })
    expect(undoState(revs)).toEqual({ undo: 2, redo: 3 })
    revs.push({ n: 5, how: 'undo', target: 2 })
    expect(undoState(revs)).toEqual({ undo: null, redo: 2 })
    revs.push({ n: 6, how: 'redo', target: 2 })
    expect(undoState(revs)).toEqual({ undo: 2, redo: 3 })
  })

  it('cannot undo the create or import floor', () => {
    expect(undoState([{ n: 1, how: 'create', target: null }])).toEqual({ undo: null, redo: null })
    expect(undoState([{ n: 1, how: 'import', target: null }])).toEqual({ undo: null, redo: null })
  })

  it('a new edit after an undo clears redo', () => {
    const revs = [
      { n: 1, how: 'create', target: null },
      { n: 2, how: 'edit', target: null },
      { n: 3, how: 'undo', target: 2 }
    ]
    expect(undoState(revs).redo).toBe(2)
    revs.push({ n: 4, how: 'api', target: null })
    expect(undoState(revs)).toEqual({ undo: 4, redo: null })
  })

  it('restore and recovered push onto the undo stack', () => {
    const revs = [
      { n: 1, how: 'create', target: null },
      { n: 2, how: 'restore', target: 1 },
      { n: 3, how: 'recovered', target: null }
    ]
    expect(undoState(revs)).toEqual({ undo: 3, redo: null })
  })
})
