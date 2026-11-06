import { describe, expect, it } from 'vitest'
import { SIDE_MARGIN, sideBox, sideFrames, type Geo } from '../../app/utils/boardView'

/** A 10 x 5 board at 2.54 mm, mirrored or not (only what sideExtent reads). */
const geo = (mirrored: boolean): Geo => {
  const span = 9 * 2.54
  const x = (v: number) => (mirrored ? span - v : v)
  return {
    pitch: 2.54, cols: 10, rows: 5, span, mirrored, x,
    pt: h => ({ x: x((h.col - 1) * 2.54), y: (h.row - 1) * 2.54 }),
    rect: r => ({ x: mirrored ? span - r.x - r.w : r.x, y: r.y, w: r.w, h: r.h })
  }
}

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
})

describe('sideFrames', () => {
  it('puts the top on the left, the bottom on the right after a gap', () => {
    const f = sideFrames({ top: { w: 50, h: 60 }, bottom: { w: 40, h: 60 } })
    expect(f.top).toEqual({ x: 0, y: 0, w: 50, h: 60 })
    expect(f.bottom).toEqual({ x: 60, y: 0, w: 40, h: 60 })
  })
})
