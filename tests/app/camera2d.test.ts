import { describe, expect, it } from 'vitest'
import {
  DRAG_PX, easeView, fitRect, isDrag, loadView, panBy, parseView, saveView, unionRect, viewKey, zoomAt, zoomLimits,
  type Camera
} from '../../app/utils/camera2d'

const limits = { min: 0.5, max: 8 }
/** Board (world) point -> screen point under a camera. */
const toScreen = (c: Camera, p: { x: number, y: number }) => ({ x: p.x * c.scale + c.x, y: p.y * c.scale + c.y })
const toWorld = (c: Camera, p: { x: number, y: number }) => ({ x: (p.x - c.x) / c.scale, y: (p.y - c.y) / c.scale })

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { map: m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}
const throwing = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  }
}

describe('zoomAt', () => {
  it('keeps the board point under the cursor in place', () => {
    const c: Camera = { x: 40, y: -12, scale: 2 }
    const cursor = { x: 300, y: 170 }
    const before = toWorld(c, cursor)
    for (const f of [1.25, 0.8, 3, 1 / 3]) {
      const z = zoomAt(c, cursor, f, limits)
      expect(z.scale).toBeCloseTo(2 * f)
      const after = toScreen(z, before)
      expect(after.x).toBeCloseTo(cursor.x)
      expect(after.y).toBeCloseTo(cursor.y)
    }
  })

  it('clamps the scale, still anchored at the cursor', () => {
    const c: Camera = { x: 0, y: 0, scale: 4 }
    const cursor = { x: 100, y: 50 }
    const w = toWorld(c, cursor)
    const big = zoomAt(c, cursor, 100, limits)
    expect(big.scale).toBe(8)
    expect(toScreen(big, w).x).toBeCloseTo(100)
    expect(zoomAt(c, cursor, 0.001, limits).scale).toBe(0.5)
  })

  it('a factor at the limit changes nothing', () => {
    const c: Camera = { x: 5, y: 6, scale: 8 }
    expect(zoomAt(c, { x: 10, y: 10 }, 2, limits)).toEqual(c)
  })
})

describe('fitRect', () => {
  it('frames a wide rect: width-bound, centred', () => {
    const v = fitRect({ x: 0, y: 0, w: 200, h: 50 }, { w: 1000, h: 600 }, 50)
    expect(v.scale).toBeCloseTo(4.5) // (1000 - 100) / 200
    const tl = toScreen(v, { x: 0, y: 0 })
    const br = toScreen(v, { x: 200, y: 50 })
    expect(tl.x).toBeCloseTo(50)
    expect(br.x).toBeCloseTo(950)
    expect((tl.y + br.y) / 2).toBeCloseTo(300)
  })

  it('frames a tall rect: height-bound, centred, with an offset origin', () => {
    const v = fitRect({ x: 10, y: -20, w: 40, h: 100 }, { w: 800, h: 520 }, 10)
    expect(v.scale).toBeCloseTo(5) // (520 - 20) / 100
    const tl = toScreen(v, { x: 10, y: -20 })
    const br = toScreen(v, { x: 50, y: 80 })
    expect(tl.y).toBeCloseTo(10)
    expect(br.y).toBeCloseTo(510)
    expect((tl.x + br.x) / 2).toBeCloseTo(400)
  })

  it('stays finite and positive in a viewport smaller than the margins', () => {
    const v = fitRect({ x: 0, y: 0, w: 10, h: 10 }, { w: 20, h: 20 }, 40)
    expect(v.scale).toBeGreaterThan(0)
    expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true)
  })
})

describe('zoomLimits and unionRect', () => {
  it('limits are 25% to 800% of the fit scale', () => {
    expect(zoomLimits(4)).toEqual({ min: 1, max: 32 })
  })
  it('unionRect bounds every rect', () => {
    expect(unionRect([{ x: 0, y: 0, w: 10, h: 5 }, { x: 15, y: -2, w: 10, h: 4 }])).toEqual({ x: 0, y: -2, w: 25, h: 7 })
  })
})

describe('panBy', () => {
  it('moves the camera by screen pixels, keeping the scale', () => {
    expect(panBy({ x: 1, y: 2, scale: 3 }, 10, -4)).toEqual({ x: 11, y: -2, scale: 3 })
  })
})

describe('isDrag', () => {
  it('under 4 px is a click, 4 px or more is a drag', () => {
    expect(DRAG_PX).toBe(4)
    expect(isDrag(0, 0)).toBe(false)
    expect(isDrag(3, 0)).toBe(false)
    expect(isDrag(2.8, 2.8)).toBe(false) // 3.96 px
    expect(isDrag(4, 0)).toBe(true)
    expect(isDrag(0, -4)).toBe(true)
    expect(isDrag(3, 3)).toBe(true) // 4.24 px
  })
  it('takes a threshold (0: any move is a drag, as in the Navigate tool)', () => {
    expect(isDrag(0.5, 0, 0)).toBe(true)
    expect(isDrag(0, 0, 0)).toBe(false)
  })
})

describe('easeView', () => {
  const a: Camera = { x: 0, y: 100, scale: 1 }
  const b: Camera = { x: 100, y: 0, scale: 3 }
  it('starts at from and ends at to', () => {
    expect(easeView(a, b, 0)).toEqual(a)
    expect(easeView(a, b, 1)).toEqual(b)
    expect(easeView(a, b, 2)).toEqual(b)
    expect(easeView(a, b, -1)).toEqual(a)
  })
  it('eases out: past halfway at half time, and monotonic', () => {
    const mid = easeView(a, b, 0.5)
    expect(mid.x).toBeGreaterThan(50)
    expect(mid.y).toBeLessThan(50)
    let last = -1
    for (let t = 0; t <= 1; t += 0.05) {
      const v = easeView(a, b, t)
      expect(v.x).toBeGreaterThanOrEqual(last)
      last = v.x
    }
  })
})

describe('view storage', () => {
  it('keys the view by board name', () => {
    expect(viewKey('channel board')).toBe('wirebender:view:channel board')
  })

  it('round-trips through storage', () => {
    const s = memStorage()
    const v: Camera = { x: -12.5, y: 30, scale: 7.25 }
    expect(saveView('B', v, () => s)).toBe(true)
    expect(JSON.parse(s.map.get('wirebender:view:B')!)).toEqual(v)
    expect(loadView('B', () => s)).toEqual(v)
    expect(loadView('other', () => s)).toBeNull()
  })

  it('rejects malformed values', () => {
    for (const raw of [null, '', '{', 'null', '[]', '42', '{"x":1,"y":2}', '{"x":1,"y":2,"scale":0}',
      '{"x":1,"y":2,"scale":-3}', '{"x":"1","y":2,"scale":3}', '{"x":1,"y":null,"scale":3}', '{"x":1e999,"y":2,"scale":3}'])
      expect(parseView(raw), String(raw)).toBeNull()
    expect(parseView('{"x":1,"y":2,"scale":3,"extra":true}')).toEqual({ x: 1, y: 2, scale: 3 })
  })

  it('survives storage that throws or is missing', () => {
    expect(loadView('B', () => throwing)).toBeNull()
    expect(saveView('B', { x: 0, y: 0, scale: 1 }, () => throwing)).toBe(false)
    const getterThrows = () => {
      throw new Error('SecurityError')
    }
    expect(loadView('B', getterThrows)).toBeNull()
    expect(saveView('B', { x: 0, y: 0, scale: 1 }, getterThrows)).toBe(false)
    expect(loadView('B', () => null)).toBeNull()
    expect(saveView('B', { x: 0, y: 0, scale: 1 }, () => undefined)).toBe(false)
  })
})
