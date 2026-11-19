import { describe, expect, it } from 'vitest'
import { newBoardBody, PRESET_ITEMS, SHAPE_ITEMS, shownSize, type NewBoardDraft } from '../../app/utils/newBoard'

const draft = (over: Partial<NewBoardDraft> = {}): NewBoardDraft =>
  ({ name: 'B', preset: 'custom', cols: 30, rows: 20, type: 'one-sided', shape: 'rect', cornerHoles: 2, ...over })

describe('the shape in the "New board" form', () => {
  it('a rectangle sends no shape (today\'s body)', () => {
    expect(newBoardBody(draft({ cols: 10, rows: 6 }))).toEqual({ name: 'B', cols: 10, rows: 6, type: 'one-sided' })
  })

  it('round sends { kind: round }', () => {
    expect(newBoardBody(draft({ shape: 'round' }))).toMatchObject({ shape: { kind: 'round' } })
  })

  it('chamfered or notched corners cut all four, by the corner size', () => {
    const cut = { cut: 'notch', holes: 3 }
    expect(newBoardBody(draft({ shape: 'notch', cornerHoles: 3 }))).toMatchObject({
      shape: { kind: 'corners', corners: { topLeft: cut, topRight: cut, bottomLeft: cut, bottomRight: cut } }
    })
    expect(newBoardBody(draft({ shape: 'chamfer', cornerHoles: 1 }))).toMatchObject({
      shape: { kind: 'corners', corners: { topLeft: { cut: 'chamfer', holes: 1 } } }
    })
  })

  it('a preset shows its own shape, fixed, and sends only its id', () => {
    expect(shownSize(draft({ preset: 'chogori-22004515', shape: 'notch' }))).toMatchObject({ shape: 'round', fixed: true })
    expect(shownSize(draft({ preset: 'proto-5x7', shape: 'round' }))).toMatchObject({ shape: 'rect', fixed: true })
    expect(newBoardBody(draft({ preset: 'proto-5x7', shape: 'round' }))).toEqual({ name: 'B', preset: 'proto-5x7' })
  })

  it('the shape menu', () => {
    expect(SHAPE_ITEMS.map(i => i.value)).toEqual(['rect', 'round', 'chamfer', 'notch'])
  })
})

describe('the "New board" form', () => {
  it('an emptied number field is sent empty (null), for the server to refuse', () => {
    expect(newBoardBody(draft({ cols: null, rows: 6 }))).toEqual({ name: 'B', cols: null, rows: 6, type: 'one-sided' })
    expect(newBoardBody(draft({ rows: null }))).toMatchObject({ rows: null })
    expect(newBoardBody(draft({ shape: 'notch', cornerHoles: null }))).toMatchObject({ shape: { kind: 'corners', corners: { topLeft: { cut: 'notch', holes: null } } } })
  })

  it('Custom sends today\'s body', () => {
    expect(newBoardBody(draft({ cols: 10, rows: 6, type: 'two-sided' }))).toEqual({ name: 'B', cols: 10, rows: 6, type: 'two-sided' })
  })

  it('a preset sends its id only', () => {
    expect(newBoardBody(draft({ preset: 'proto-7x9' }))).toEqual({ name: 'B', preset: 'proto-7x9' })
  })

  it('a preset shows its own size, fixed', () => {
    expect(shownSize(draft({ preset: 'chogori-22004515' }))).toEqual({ cols: 2, rows: 2, type: 'one-sided', shape: 'round', fixed: true })
  })

  it('back to Custom: the Custom values from before, editable again', () => {
    const d = draft({ preset: 'proto-5x7', cols: 12, rows: 9, type: 'one-sided' })
    expect(shownSize(d)).toMatchObject({ cols: 18, rows: 24, fixed: true })
    expect(shownSize({ ...d, preset: 'custom' })).toEqual({ cols: 12, rows: 9, type: 'one-sided', shape: 'rect', fixed: false })
  })

  it('the menu: Custom first, then every preset', () => {
    expect(PRESET_ITEMS[0]).toEqual({ label: 'Custom', value: 'custom' })
    expect(PRESET_ITEMS).toHaveLength(9)
    expect(PRESET_ITEMS.map(i => i.value)).toContain('chogori-22004515')
    expect(PRESET_ITEMS.map(i => i.value)).toContain('bb-400')
  })
  it('a breadboard preset shows its size, fixed, as a breadboard', () => {
    expect(shownSize({ name: 'x', preset: 'bb-400', cols: 3, rows: 3, type: 'one-sided', shape: 'round', cornerHoles: 2 }))
      .toEqual({ cols: 30, rows: 18, type: 'breadboard', shape: 'rect', fixed: true })
  })
})
