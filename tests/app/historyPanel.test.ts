import { describe, expect, it } from 'vitest'
import { previewBanner, relativeTime, revisionLabel, type RevisionRow } from '../../app/utils/history'

const row = (o: Partial<RevisionRow>): RevisionRow => ({ n: 42, createdAt: 0, author: 'Claude', how: 'edit', target: null, summary: '', ...o })

describe('revisionLabel', () => {
  it('shows the number, the author and how', () => {
    expect(revisionLabel(row({ how: 'undo', target: 41 }))).toBe('#42 · Claude · undo of #41')
    expect(revisionLabel(row({ how: 'redo', target: 40 }))).toBe('#42 · Claude · redo of #40')
    expect(revisionLabel(row({ how: 'restore', target: 7 }))).toBe('#42 · Claude · restore of #7')
    for (const how of ['create', 'import', 'edit', 'api', 'recovered'] as const) {
      expect(revisionLabel(row({ how, author: 'Local · This computer' }))).toBe(`#42 · Local · This computer · ${how}`)
    }
  })
})

describe('relativeTime', () => {
  const now = 1_000_000_000_000
  it('rounds to the largest unit', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now')
    expect(relativeTime(now + 5_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 d ago')
    expect(relativeTime(now - 90 * 86_400_000, now)).toBe('2001-06-11')
  })
})

describe('previewBanner', () => {
  it('reads as the brief says', () => {
    expect(previewBanner({ n: 5, author: 'Local · This computer' }))
      .toBe('Viewing #5 by Local · This computer. Restore makes it the current board; nothing is lost.')
  })
})
