import { describe, expect, it } from 'vitest'
import { moveBar } from '../../app/utils/moveBar'
import type { Held } from '../../app/composables/useTools'
import { parseHole } from '~core/holes'
import { axial, mk } from '../core/helpers'

const H = parseHole
const PAUSED = 'Reconnecting'
const board = mk({
  parts: [axial('R1', 'B2', 'B5', 'N1')],
  wires: [
    { id: 'W1', kind: 'laid', side: 'bottom', points: ['B2', 'B5'], joints: [], bareSegments: [] },
    { id: 'W2', kind: 'flying', side: 'bottom', points: ['C2', 'D5'], joints: [], bareSegments: [] }
  ]
})
const held = (pick: Held['pick']): Held => ({ pick, side: 'top', target: pick.at, turns: 0, bend: 'row-first', snapshot: '' })
const part = held({ kind: 'part', ref: 'R1', at: H('B2') })
const ok = { board, reason: null }
const base = { coarse: true, held: part, preview: ok, lockedTitle: null, pausedTitle: PAUSED, board }

describe('moveBar', () => {
  it('no bar without a touch screen, or with nothing held', () => {
    expect(moveBar({ ...base, coarse: false })).toBeNull()
    expect(moveBar({ ...base, held: null })).toBeNull()
  })

  it('no bar while editing is off for good (3D, view only, a revision)', () => {
    expect(moveBar({ ...base, lockedTitle: '3D view: look only' })).toBeNull()
  })

  it('while reconnecting the bar stays, marked paused (Rotate, Switch bend, Place disabled; Cancel never)', () => {
    expect(moveBar({ ...base, lockedTitle: PAUSED })).toMatchObject({ paused: true, rotate: true })
    expect(moveBar(base)).toMatchObject({ paused: false })
  })

  it('a part or a whole wire rotates; only a laid wire\'s end switches bend', () => {
    expect(moveBar(base)).toMatchObject({ rotate: true, bend: false })
    expect(moveBar({ ...base, held: held({ kind: 'wire-end', id: 'W1', end: 'last', at: H('B5') }) })).toMatchObject({ rotate: false, bend: true })
    expect(moveBar({ ...base, held: held({ kind: 'wire-end', id: 'W2', end: 'last', at: H('D5') }) })).toMatchObject({ rotate: false, bend: false })
  })

  it('Place follows whether the spot is allowed', () => {
    expect(moveBar(base)!.canPlace).toBe(true)
    expect(moveBar({ ...base, preview: { board, reason: 'R1 would overlap R2.' } })!.canPlace).toBe(false)
  })
})
