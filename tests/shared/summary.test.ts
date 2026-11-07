import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBoard, type BoardFile } from '~core/schema'
import { summarize } from '#shared/summary'

function board2(): BoardFile {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/channel-board-2.json', import.meta.url)), 'utf8'))
  const res = parseBoard(raw)
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const newTrail = (id: string) => ({ id, side: 'bottom' as const, points: ['A1', 'A2'], joints: [] })

describe('summarize', () => {
  it('says created for a new board', () => {
    expect(summarize(null, board2())).toBe('created')
  })
  it('names a changed wire and its side', () => {
    const b = board2()
    const a = clone(b)
    a.wires.find(w => w.id === 'W5')!.side = 'top'
    expect(summarize(b, a)).toBe('wire W5 changed (top)')
  })
  it('names added and removed trails', () => {
    const b = board2()
    const a = clone(b)
    a.trails = a.trails.filter(t => t.id !== 'T3')
    a.trails.push(newTrail('T40'))
    expect(summarize(b, a)).toBe('trail T40 added; trail T3 removed')
  })
  it('lists the first 3 and counts the rest', () => {
    const b = board2()
    const a = clone(b)
    for (const id of ['T40', 'T41', 'T42', 'T43', 'T44']) a.trails.push(newTrail(id))
    expect(summarize(b, a)).toBe('trail T40 added; trail T41 added; trail T42 added; and 2 more')
  })
  it('says no change', () => {
    const b = board2()
    expect(summarize(b, { ...clone(b), revision: 99 })).toBe('no change')
  })
})
