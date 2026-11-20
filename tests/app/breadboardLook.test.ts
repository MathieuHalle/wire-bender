import { describe, expect, it } from 'vitest'
import { channelRect, railLines, stripBands } from '../../app/utils/breadboardLook'
import { makeGeo, pageKey } from '../../app/utils/boardView'
import { breadboard400, mk } from '../core/helpers'

const p = 2.54

describe('the breadboard look', () => {
  const b = mk({ board: breadboard400() })
  const geo = makeGeo(b, 'none')
  it('puts the channel between rows f (8) and e (11), across the board', () => {
    const c = channelRect(b, geo)!
    expect(c.x).toBeCloseTo(-p / 2)
    expect(c.w).toBeCloseTo(30 * p)
    expect(c.y).toBeCloseTo(7 * p + 0.75 * p) // row 8's centre is 7 pitches down
    expect(c.y + c.h).toBeCloseTo(10 * p - 0.75 * p)
  })
  it('draws a red or blue line outside each rail, away from its partner', () => {
    const lines = railLines(b, geo)
    expect(lines.map(l => `${l.sign}${l.color}`)).toEqual(['+#d62839', '-#1f5fbf', '-#1f5fbf', '+#d62839'])
    // Row 1 (+) has its partner below: the line is above it; row 2 (-) below it.
    expect(lines[0]!.y).toBeCloseTo(-0.6 * p)
    expect(lines[1]!.y).toBeCloseTo(1.6 * p)
    expect(lines[0]!.x1).toBeCloseTo(1 * p - p / 2) // column 2
    expect(lines[0]!.x2).toBeCloseTo(29 * p + p / 2) // column 30
  })
  it('has no channel or rails without row labels (the 170 has no rails)', () => {
    const plain = mk({ board: { strips: [{ from: 'A1', to: 'A10' }] } })
    expect(channelRect(plain, makeGeo(plain, 'none'))).toBeNull()
    expect(railLines(plain, makeGeo(plain, 'none'))).toEqual([])
  })
})

describe('stripboard bands', () => {
  it('covers each strip, mirrored with the side', () => {
    const b = mk({ board: { strips: [{ from: 'A1', to: 'A10' }] } })
    const [band] = stripBands(b, makeGeo(b, 'lr'))
    expect(band!.w).toBeCloseTo(9 * p + 0.84 * p)
    expect(band!.h).toBeCloseTo(0.84 * p)
  })
})

describe('pageKey on a breadboard', () => {
  it('F frames the top, never the bottom', () => {
    expect(pageKey('f', 'top', 'both', true)).toEqual({ view: 'top' })
    expect(pageKey('f', 'both', 'both', true)).toEqual({ view: 'top' })
    expect(pageKey('f', 'top', 'both')).toEqual({ view: 'bottom' })
  })
})

describe('stripboard bands with a cut', () => {
  it('leaves a gap at the cut', () => {
    const b = mk({ board: { strips: [{ from: 'A1', to: 'A10' }] }, cuts: ['A4'] })
    const bands = stripBands(b, makeGeo(b, 'none'))
    expect(bands).toHaveLength(2)
    expect(bands[0]!.x + bands[0]!.w).toBeLessThan(3 * p - 0.4 * p)
    expect(bands[1]!.x).toBeGreaterThan(3 * p + 0.4 * p)
  })
})
