import { describe, expect, it } from 'vitest'
import { boardBytes, boardFacts, formatBytes } from '../../app/utils/boardInfo'
import type { RevisionRow } from '../../app/utils/history'

const row = (n: number, createdAt: number, author: string): RevisionRow =>
  ({ n, createdAt, author, how: 'edit', target: null, summary: '', imported: false }) as RevisionRow

describe('board info', () => {
  it('reads created, last change and the revision count from the newest-first list', () => {
    const facts = boardFacts([row(3, 3000, 'Sam'), row(2, 2000, 'Ann'), row(1, 1000, 'Ann')])
    expect(facts).toEqual({ createdAt: 1000, last: { n: 3, at: 3000, author: 'Sam' }, revisions: 3 })
  })

  it('has no facts before the list has loaded', () => {
    expect(boardFacts([])).toBeNull()
  })

  it('formats sizes in B, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(28_400)).toBe('28 KB')
    expect(formatBytes(1_536_000)).toBe('1.5 MB')
  })

  it('measures a board as its compact JSON, in UTF-8 bytes', () => {
    expect(boardBytes({ name: 'é' } as never)).toBe(new TextEncoder().encode('{"name":"é"}').length)
  })
})
