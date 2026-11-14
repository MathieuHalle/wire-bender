// The line under the canvas while the Move tool holds something.
import { describe, expect, it } from 'vitest'
import { parseHole } from '~core/holes'
import type { MoveResult } from '~core/move'
import type { Held } from '../../app/composables/useTools'
import { moveHint } from '../../app/utils/moveHint'
import { mk } from '../core/helpers'

const h = parseHole
const wire = (id: string, points: string[], kind: 'laid' | 'flying' = 'laid') =>
  ({ id, kind, side: 'bottom' as const, points, bareSegments: [] as number[], joints: [] as string[] })
const board = mk({ wires: [wire('W2', ['B2', 'B5', 'D5']), wire('W4', ['F1', 'F8'], 'flying')] })
const ok: MoveResult = { board, reason: null }

const held = (pick: Held['pick']): Held =>
  ({ pick, side: 'bottom', target: pick.at, turns: 0, bend: 'row-first', snapshot: '' })

describe('moveHint', () => {
  it('is null when nothing is held', () => {
    expect(moveHint(null, null)).toBeNull()
  })

  it('names a held part', () => {
    expect(moveHint(held({ kind: 'part', ref: 'R3', at: h('C3') }), ok))
      .toBe('Moving R3: click to place, R to rotate, Esc to put back')
  })

  it('names a whole wire', () => {
    expect(moveHint(held({ kind: 'wire', id: 'W2', at: h('B3') }), ok))
      .toBe('Moving wire W2: click to place, R to rotate, Esc to put back')
  })

  it('names a laid-wire end, with the bend key', () => {
    expect(moveHint(held({ kind: 'wire-end', id: 'W2', end: 'first', at: h('B2') }), ok))
      .toBe('Moving the end of wire W2: click to place, Tab to switch the bend, Esc to put back')
  })

  it('names a flying-wire end, without the bend key (it has none)', () => {
    expect(moveHint(held({ kind: 'wire-end', id: 'W4', end: 'last', at: h('F8') }), ok))
      .toBe('Moving the end of wire W4: click to place, Esc to put back')
  })

  it('gives the reason when it cannot be placed there', () => {
    const reason = 'R3 would overlap R1.'
    expect(moveHint(held({ kind: 'part', ref: 'R3', at: h('C3') }), { board, reason }))
      .toBe('R3 would overlap R1. · Esc to put back')
  })
})
