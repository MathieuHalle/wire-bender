import { describe, expect, it } from 'vitest'
import {
  clampPan, DRAG_PX, easeView, fitRect, fromStored, gestureStep, IDLE, isDrag, keepCentre, loadView, panBy, parseView,
  saveView, toStored, unionRect, viewKey, zoomAt, zoomLimits, type Camera, type GestureEvent, type GestureState
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

describe('stored view (board point at the centre, zoom relative to fit)', () => {
  it('round-trips camera -> stored -> camera at the same size', () => {
    const c: Camera = { x: -120, y: 40, scale: 6 }
    const size = { w: 1000, h: 600 }
    const v = toStored(c, size, 3)
    expect(v.zoom).toBeCloseTo(2)
    expect(v.cx).toBeCloseTo((500 + 120) / 6)
    expect(v.cy).toBeCloseTo((300 - 40) / 6)
    const back = fromStored(v, size, 3)
    expect(back.x).toBeCloseTo(c.x)
    expect(back.y).toBeCloseTo(c.y)
    expect(back.scale).toBeCloseTo(c.scale)
  })

  it('keeps the centre point and the relative zoom in a different canvas size', () => {
    const v = { cx: 30, cy: 40, zoom: 2 }
    const c = fromStored(v, { w: 356, h: 206 }, 1.5)
    expect(c.scale).toBeCloseTo(3)
    expect(toWorld(c, { x: 178, y: 103 }).x).toBeCloseTo(30)
    expect(toWorld(c, { x: 178, y: 103 }).y).toBeCloseTo(40)
  })

  it('clamps the zoom to 25%..800% of fit', () => {
    expect(fromStored({ cx: 0, cy: 0, zoom: 100 }, { w: 100, h: 100 }, 2).scale).toBeCloseTo(16)
    expect(fromStored({ cx: 0, cy: 0, zoom: 0.01 }, { w: 100, h: 100 }, 2).scale).toBeCloseTo(0.5)
  })
})

describe('keepCentre', () => {
  it('keeps the board point at the canvas centre when the canvas resizes', () => {
    const c: Camera = { x: 10, y: 20, scale: 4 }
    const before = toWorld(c, { x: 500, y: 300 })
    const k = keepCentre(c, { w: 1000, h: 600 }, { w: 700, h: 500 })
    const after = toWorld(k, { x: 350, y: 250 })
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(k.scale).toBe(4)
  })
  it('a resize from nothing changes nothing', () => {
    const c: Camera = { x: 10, y: 20, scale: 4 }
    expect(keepCentre(c, { w: 0, h: 0 }, { w: 700, h: 500 })).toEqual(c)
  })
})

describe('clampPan', () => {
  const content = { x: 0, y: 0, w: 100, h: 50 } // 400 x 200 px at scale 4
  const vp = { w: 800, h: 600 }
  it('leaves a camera with the content in view alone', () => {
    const c: Camera = { x: 100, y: 100, scale: 4 }
    expect(clampPan(c, content, vp)).toEqual(c)
  })
  it('keeps at least 15% of the content in view on every side', () => {
    expect(clampPan({ x: -1000, y: 0, scale: 4 }, content, vp).x).toBeCloseTo(60 - 400) // right edge at 60 px
    expect(clampPan({ x: 5000, y: 0, scale: 4 }, content, vp).x).toBeCloseTo(800 - 60)
    expect(clampPan({ x: 0, y: -900, scale: 4 }, content, vp).y).toBeCloseTo(30 - 200)
    expect(clampPan({ x: 0, y: 900, scale: 4 }, content, vp).y).toBeCloseTo(600 - 30)
  })
  it('content larger than the canvas: 15% of the canvas is enough', () => {
    const c = clampPan({ x: -100000, y: 0, scale: 100 }, content, vp) // 10000 px wide
    expect(c.x + 100 * 100).toBeCloseTo(800 * 0.15)
  })
})

describe('gestureStep', () => {
  const down = (id: number, x: number, y: number, extra: Partial<Extract<GestureEvent, { type: 'down' }>> = {}): GestureEvent =>
    ({ type: 'down', id, p: { x, y }, button: 0, pointerType: 'mouse', panNow: false, threshold: DRAG_PX, ...extra })
  const move = (id: number, x: number, y: number, buttons = 1, pointerType = 'mouse'): GestureEvent =>
    ({ type: 'move', id, p: { x, y }, buttons, pointerType })
  const up = (id: number): GestureEvent => ({ type: 'up', id })
  const run = (events: GestureEvent[], from: GestureState = IDLE) => {
    let s = from
    const out: ReturnType<typeof gestureStep>[] = []
    for (const e of events) {
      const r = gestureStep(s, e)
      out.push(r)
      s = r.state
    }
    return { s, out }
  }

  it('a press that moves under 4 px is a click: no pan, the click is kept', () => {
    const { s, out } = run([down(1, 10, 10), move(1, 12, 11), up(1)])
    expect(out.every(o => !o.pan && !o.zoom)).toBe(true)
    expect(s.swallowClick).toBe(false)
    expect(s.mode).toBe('idle')
  })

  it('4 px or more pans from the press point and swallows the click', () => {
    const { s, out } = run([down(1, 10, 10), move(1, 12, 10), move(1, 15, 10), move(1, 20, 14), up(1)])
    expect(out[1]!.pan).toBeUndefined()
    expect(out[2]!.pan).toEqual({ dx: 5, dy: 0 })
    expect(out[3]!.pan).toEqual({ dx: 5, dy: 4 })
    expect(s.swallowClick).toBe(true)
    expect(out[2]!.state.mode).toBe('pan')
  })

  it('threshold 0 (Navigate) pans on any move; panNow (right, middle, Space) pans at once', () => {
    expect(run([down(1, 0, 0, { threshold: 0 }), move(1, 1, 0)]).out[1]!.pan).toEqual({ dx: 1, dy: 0 })
    const r = run([down(1, 0, 0, { button: 2, panNow: true })])
    expect(r.s.mode).toBe('pan')
    expect(r.s.swallowClick).toBe(true)
  })

  it('a new press clears a swallow left over from a release that went elsewhere', () => {
    const { s } = run([down(1, 0, 0), move(1, 10, 0)])
    expect(s.swallowClick).toBe(true)
    expect(gestureStep({ ...IDLE, swallowClick: true }, down(2, 0, 0)).state.swallowClick).toBe(false)
  })

  it('a mouse move with no button down cancels a stuck pan', () => {
    const { s, out } = run([down(1, 0, 0), move(1, 10, 0), move(1, 30, 0, 0)])
    expect(out[2]!.pan).toBeUndefined()
    expect(out[2]!.cancelled).toBe(true)
    expect(s).toEqual(IDLE)
  })

  it('cancel resets everything', () => {
    const { s } = run([down(1, 0, 0), move(1, 10, 0), { type: 'cancel' }])
    expect(s).toEqual(IDLE)
  })

  it('two touches pinch: zoom about the midpoint by the distance ratio, pan by its move', () => {
    const t = { pointerType: 'touch' as const }
    const { out } = run([down(1, 0, 0, t), down(2, 100, 0, t), move(2, 200, 0, 1, 'touch')])
    expect(out[1]!.state.mode).toBe('pinch')
    expect(out[1]!.state.swallowClick).toBe(true)
    expect(out[2]!.pan).toEqual({ dx: 50, dy: 0 })
    expect(out[2]!.zoom).toEqual({ at: { x: 100, y: 0 }, factor: 2 })
  })

  it('lifting one finger of a pinch hands over to a pan with the other, without a jump', () => {
    const t = { pointerType: 'touch' as const }
    const { s, out } = run([down(1, 0, 0, t), down(2, 100, 0, t), up(2), move(1, 10, 5, 1, 'touch')])
    expect(out[2]!.state.mode).toBe('pan')
    expect(out[3]!.pan).toEqual({ dx: 10, dy: 5 })
    expect(s.swallowClick).toBe(true)
  })

  it('a third pointer is ignored: no jump, no zoom from it', () => {
    const t = { pointerType: 'touch' as const }
    const base = run([down(1, 0, 0, t), down(2, 100, 0, t)]).s
    const third = gestureStep(base, down(3, 500, 500, t))
    expect(third.state).toEqual(base)
    const moved = gestureStep(third.state, move(3, 900, 900, 1, 'touch'))
    expect(moved.pan).toBeUndefined()
    expect(moved.zoom).toBeUndefined()
    expect(gestureStep(moved.state, up(3)).state).toEqual(base)
  })

  it('other mouse buttons (back, forward) start nothing', () => {
    expect(gestureStep(IDLE, down(1, 0, 0, { button: 3 })).state).toEqual(IDLE)
  })
})

describe('view storage', () => {
  it('keys the view by board name', () => {
    expect(viewKey('channel board')).toBe('wirebender:view:channel board')
  })

  it('round-trips through storage', () => {
    const s = memStorage()
    const v = { cx: -12.5, cy: 30, zoom: 7.25 }
    expect(saveView('B', v, () => s)).toBe(true)
    expect(JSON.parse(s.map.get('wirebender:view:B')!)).toEqual(v)
    expect(loadView('B', () => s)).toEqual(v)
    expect(loadView('other', () => s)).toBeNull()
  })

  it('rejects malformed values and the old window-dependent {x, y, scale} format', () => {
    for (const raw of [null, '', '{', 'null', '[]', '42', '{"cx":1,"cy":2}', '{"cx":1,"cy":2,"zoom":0}',
      '{"cx":1,"cy":2,"zoom":-3}', '{"cx":"1","cy":2,"zoom":3}', '{"cx":1,"cy":null,"zoom":3}', '{"cx":1e999,"cy":2,"zoom":3}',
      '{"x":1,"y":2,"scale":3}'])
      expect(parseView(raw), String(raw)).toBeNull()
    expect(parseView('{"cx":1,"cy":2,"zoom":3,"extra":true}')).toEqual({ cx: 1, cy: 2, zoom: 3 })
  })

  it('survives storage that throws or is missing', () => {
    expect(loadView('B', () => throwing)).toBeNull()
    expect(saveView('B', { cx: 0, cy: 0, zoom: 1 }, () => throwing)).toBe(false)
    const getterThrows = () => {
      throw new Error('SecurityError')
    }
    expect(loadView('B', getterThrows)).toBeNull()
    expect(saveView('B', { cx: 0, cy: 0, zoom: 1 }, getterThrows)).toBe(false)
    expect(loadView('B', () => null)).toBeNull()
    expect(saveView('B', { cx: 0, cy: 0, zoom: 1 }, () => undefined)).toBe(false)
  })
})
