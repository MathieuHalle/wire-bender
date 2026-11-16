import { describe, expect, it } from 'vitest'
import { newBoardBody, PRESET_ITEMS, shownSize, type NewBoardDraft } from '../../app/utils/newBoard'

const draft = (over: Partial<NewBoardDraft> = {}): NewBoardDraft =>
  ({ name: 'B', preset: 'custom', cols: 30, rows: 20, type: 'one-sided', ...over })

describe('the "New board" form', () => {
  it('Custom sends today\'s body', () => {
    expect(newBoardBody(draft({ cols: 10, rows: 6, type: 'two-sided' }))).toEqual({ name: 'B', cols: 10, rows: 6, type: 'two-sided' })
  })

  it('a preset sends its id only', () => {
    expect(newBoardBody(draft({ preset: 'proto-7x9' }))).toEqual({ name: 'B', preset: 'proto-7x9' })
  })

  it('a preset shows its own size, fixed', () => {
    expect(shownSize(draft({ preset: 'chogori-22004515' }))).toEqual({ cols: 2, rows: 2, type: 'one-sided', fixed: true })
  })

  it('back to Custom: the Custom values from before, editable again', () => {
    const d = draft({ preset: 'proto-5x7', cols: 12, rows: 9, type: 'one-sided' })
    expect(shownSize(d)).toMatchObject({ cols: 18, rows: 24, fixed: true })
    expect(shownSize({ ...d, preset: 'custom' })).toEqual({ cols: 12, rows: 9, type: 'one-sided', fixed: false })
  })

  it('the menu: Custom first, then every preset', () => {
    expect(PRESET_ITEMS[0]).toEqual({ label: 'Custom', value: 'custom' })
    expect(PRESET_ITEMS).toHaveLength(5)
    expect(PRESET_ITEMS.map(i => i.value)).toContain('chogori-22004515')
  })
})
