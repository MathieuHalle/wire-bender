import { describe, expect, it } from 'vitest'
import { makeGeo, SIDE_MARGIN, sideBox, sideFrames, type Geo } from '../../app/utils/boardView'
import { mk } from '../core/helpers'

/** A 10 x 5 board at 2.54 mm, mirrored left-right or not. */
const geo = (mirrored: boolean): Geo => makeGeo(mk({ board: { cols: 10, rows: 5 } }), mirrored ? 'lr' : 'none')

describe('sideBox', () => {
  it('is the outline plus the label margin; mirroring moves only its x', () => {
    const b = sideBox(geo(false), [])
    expect(b.x).toBeCloseTo(-1.27 - SIDE_MARGIN)
    expect(b.w).toBeCloseTo(10 * 2.54 + 2 * SIDE_MARGIN)
    expect(b.h).toBeCloseTo(5 * 2.54 + 2 * SIDE_MARGIN)
    const overhang = [{ bodyRectMm: { x: -5, y: 0, w: 3, h: 2 } }] as never
    const plain = sideBox(geo(false), overhang)
    const mirrored = sideBox(geo(true), overhang)
    expect(mirrored.w).toBeCloseTo(plain.w)
    expect(mirrored.h).toBeCloseTo(plain.h)
    expect(plain.x).toBeCloseTo(-5 - SIDE_MARGIN)
    expect(mirrored.x).toBeCloseTo(-1.27 - SIDE_MARGIN)
  })

  it('mirrored top-bottom, only its y moves', () => {
    const tb = makeGeo(mk({ board: { cols: 10, rows: 5 } }), 'tb')
    const overhang = [{ bodyRectMm: { x: 0, y: -5, w: 3, h: 2 } }] as never
    const plain = sideBox(geo(false), overhang)
    const flipped = sideBox(tb, overhang)
    expect(flipped.w).toBeCloseTo(plain.w)
    expect(flipped.h).toBeCloseTo(plain.h)
    expect(flipped.x).toBeCloseTo(plain.x)
    expect(plain.y).toBeCloseTo(-5 - SIDE_MARGIN)
    expect(flipped.y).toBeCloseTo(-1.27 - SIDE_MARGIN)
    expect(flipped.y + flipped.h).toBeCloseTo(4 * 2.54 + 5 + SIDE_MARGIN)
  })
})

describe('sideFrames', () => {
  it('puts the top on the left, the bottom on the right after a gap', () => {
    const f = sideFrames({ top: { w: 50, h: 60 }, bottom: { w: 40, h: 60 } })
    expect(f.top).toEqual({ x: 0, y: 0, w: 50, h: 60 })
    expect(f.bottom).toEqual({ x: 60, y: 0, w: 40, h: 60 })
    expect(sideFrames({ top: { w: 50, h: 60 }, bottom: { w: 40, h: 60 } }, 'lr')).toEqual(f)
  })

  it('below (tb): the bottom under the top after a gap, both at x 0', () => {
    const f = sideFrames({ top: { w: 50, h: 60 }, bottom: { w: 40, h: 70 } }, 'tb')
    expect(f.top).toEqual({ x: 0, y: 0, w: 50, h: 60 })
    expect(f.bottom).toEqual({ x: 0, y: 60 + 14, w: 40, h: 70 })
  })
})
