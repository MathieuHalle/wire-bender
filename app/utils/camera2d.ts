// The 2D canvas camera: board mm -> canvas px as `screen = world * scale + (x, y)`.
// Pure helpers for zoom, fit, pan, the click-vs-drag rule, the framing animation and
// the per-board stored view. Storage access is guarded: it can be blocked, full or tampered with.

export interface Camera {
  /** Canvas px of the world origin. */
  x: number
  y: number
  /** Canvas px per board mm. */
  scale: number
}
export interface Point { x: number, y: number }
export interface Rect { x: number, y: number, w: number, h: number }
export interface Size { w: number, h: number }
export interface ZoomLimits { min: number, max: number }

/** The zoom range, relative to "fit both sides". */
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 8
/** One toolbar or key zoom step. */
export const ZOOM_STEP = 1.25
/** A press that moves this far (px) or more is a drag, not a click. */
export const DRAG_PX = 4

export function zoomLimits(fitScale: number): ZoomLimits {
  return { min: fitScale * ZOOM_MIN, max: fitScale * ZOOM_MAX }
}

/** Scales by `factor` (clamped to `limits`) about `point` (canvas px): the board point under it stays put. */
export function zoomAt(view: Camera, point: Point, factor: number, limits: ZoomLimits): Camera {
  const scale = Math.min(limits.max, Math.max(limits.min, view.scale * factor))
  if (scale === view.scale) return view
  const k = scale / view.scale
  return { x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k, scale }
}

/** The camera that shows `content` (world) centred in `viewport`, with `margin` px all round. */
export function fitRect(content: Rect, viewport: Size, margin: number): Camera {
  const w = Math.max(1, viewport.w - 2 * margin)
  const h = Math.max(1, viewport.h - 2 * margin)
  const scale = Math.min(w / Math.max(content.w, 1e-6), h / Math.max(content.h, 1e-6))
  return {
    x: viewport.w / 2 - (content.x + content.w / 2) * scale,
    y: viewport.h / 2 - (content.y + content.h / 2) * scale,
    scale
  }
}

export function panBy(view: Camera, dx: number, dy: number): Camera {
  return { x: view.x + dx, y: view.y + dy, scale: view.scale }
}

/** Whether a press that moved (dx, dy) px is a drag. Threshold 0: any move is one. */
export function isDrag(dx: number, dy: number, threshold = DRAG_PX): boolean {
  const d = Math.hypot(dx, dy)
  return threshold <= 0 ? d > 0 : d >= threshold
}

/** The bounds of several rects. */
export function unionRect(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map(r => r.x))
  const y0 = Math.min(...rects.map(r => r.y))
  const x1 = Math.max(...rects.map(r => r.x + r.w))
  const y1 = Math.max(...rects.map(r => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The camera at time `t` (0..1) of an ease-out (cubic) move from `from` to `to`. */
export function easeView(from: Camera, to: Camera, t: number): Camera {
  if (t <= 0) return from
  if (t >= 1) return to
  const e = 1 - (1 - t) ** 3
  const mix = (a: number, b: number) => a + (b - a) * e
  return { x: mix(from.x, to.x), y: mix(from.y, to.y), scale: mix(from.scale, to.scale) }
}

/** The camera after the canvas resized from `from` to `to`: the board point at the centre stays there. */
export function keepCentre(view: Camera, from: Size, to: Size): Camera {
  if (!from.w || !from.h) return view
  return panBy(view, (to.w - from.w) / 2, (to.h - from.h) / 2)
}

/**
 * Bounds a pan so at least `keep` (15%) of the content stays in view on each axis: of
 * the content's on-screen size, or of the canvas when the content is larger than it.
 */
export function clampPan(view: Camera, content: Rect, viewport: Size, keep = 0.15): Camera {
  const axis = (pos: number, start: number, len: number, vp: number) => {
    const s = view.scale
    const k = keep * Math.min(len * s, vp)
    const lo = k - len * s - start * s
    const hi = vp - k - start * s
    return Math.min(hi, Math.max(lo, pos))
  }
  const x = axis(view.x, content.x, content.w, viewport.w)
  const y = axis(view.y, content.y, content.h, viewport.h)
  return x === view.x && y === view.y ? view : { x, y, scale: view.scale }
}

// ---- Gestures: click, drag-pan, pinch ------------------------------------------------------

export type GestureMode = 'idle' | 'pending' | 'pan' | 'pinch'
export interface GestureState {
  mode: GestureMode
  /** The pointers taking part, at most two, in client px. Others are ignored. */
  pts: [number, Point][]
  /** Press point and last point of the panning pointer. */
  start: Point | null
  last: Point | null
  /** Px a press must move to become a pan (0: any move, as with Navigate). */
  threshold: number
  pinch: { mid: Point, dist: number } | null
  /** The press became a pan or pinch: the click the browser sends after it is not a click. */
  swallowClick: boolean
}
export type GestureEvent
  = | { type: 'down', id: number, p: Point, button: number, pointerType: string, panNow: boolean, threshold: number }
    | { type: 'move', id: number, p: Point, buttons: number, pointerType: string }
    | { type: 'up', id: number }
    | { type: 'cancel' }
export interface GestureResult {
  state: GestureState
  /** Pan the camera by this many px. */
  pan?: { dx: number, dy: number }
  /** Then zoom by `factor` about `at` (client px). */
  zoom?: { at: Point, factor: number }
  /** The gesture was dropped (lost release, cancel). */
  cancelled?: true
}

export const IDLE: Readonly<GestureState> = Object.freeze({
  mode: 'idle', pts: [], start: null, last: null, threshold: DRAG_PX, pinch: null, swallowClick: false
}) as GestureState

const idle = (swallowClick = false): GestureState => ({ ...IDLE, pts: [], swallowClick })

function pinchOf(pts: [number, Point][]) {
  const a = pts[0]![1]
  const b = pts[1]![1]
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) }
}

/** One pointer event through the gesture: the next state and what to do to the camera. */
export function gestureStep(state: GestureState, e: GestureEvent): GestureResult {
  if (e.type === 'cancel') return { state: idle(), cancelled: true }

  if (e.type === 'down') {
    if (e.pointerType === 'mouse' && e.button > 2) return { state }
    if (state.pts.length >= 2) return { state }
    if (state.pts.length === 0) {
      return {
        state: {
          mode: e.panNow ? 'pan' : 'pending', pts: [[e.id, e.p]], start: e.p, last: e.p,
          threshold: e.threshold, pinch: null, swallowClick: e.panNow
        }
      }
    }
    const pts: [number, Point][] = [...state.pts, [e.id, e.p]]
    return { state: { ...state, mode: 'pinch', pts, pinch: pinchOf(pts), swallowClick: true } }
  }

  if (e.type === 'move') {
    // A mouse moving with no button down: its release was lost (another app, alt-tab).
    if (e.pointerType === 'mouse' && e.buttons === 0 && state.mode !== 'idle') return { state: idle(), cancelled: true }
    const i = state.pts.findIndex(([id]) => id === e.id)
    if (i < 0) return { state }
    const pts = state.pts.map((q, j): [number, Point] => (j === i ? [e.id, e.p] : q))
    if (state.mode === 'pinch' && pts.length === 2 && state.pinch) {
      const n = pinchOf(pts)
      return {
        state: { ...state, pts, pinch: n },
        pan: { dx: n.mid.x - state.pinch.mid.x, dy: n.mid.y - state.pinch.mid.y },
        zoom: { at: n.mid, factor: n.dist / state.pinch.dist }
      }
    }
    const start = state.start ?? e.p
    const last = state.last ?? e.p
    if (state.mode === 'pending') {
      if (!isDrag(e.p.x - start.x, e.p.y - start.y, state.threshold)) return { state: { ...state, pts } }
      return { state: { ...state, pts, mode: 'pan', last: e.p, swallowClick: true }, pan: { dx: e.p.x - last.x, dy: e.p.y - last.y } }
    }
    if (state.mode === 'pan') return { state: { ...state, pts, last: e.p }, pan: { dx: e.p.x - last.x, dy: e.p.y - last.y } }
    return { state: { ...state, pts } }
  }

  // up
  const pts = state.pts.filter(([id]) => id !== e.id)
  if (pts.length === state.pts.length) return { state }
  if (pts.length === 0) return { state: idle(state.swallowClick) }
  // Lifting one finger of a pinch carries on as a pan with the other, from where it is.
  const rest = pts[0]![1]
  return { state: { ...state, pts, mode: 'pan', start: rest, last: rest, pinch: null } }
}

// ---- Stored view, per board ----------------------------------------------------------
//
// Stored by board point, not by px, so it fits any window: the world point (mm) at the
// canvas centre, and the zoom relative to "fit both sides".

export interface StoredView { cx: number, cy: number, zoom: number }

export function toStored(view: Camera, size: Size, fitScale: number): StoredView {
  return { cx: (size.w / 2 - view.x) / view.scale, cy: (size.h / 2 - view.y) / view.scale, zoom: view.scale / fitScale }
}

/** The camera for a stored view in this canvas; the zoom is clamped to its range. */
export function fromStored(v: StoredView, size: Size, fitScale: number): Camera {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom))
  const scale = zoom * fitScale
  return { x: size.w / 2 - v.cx * scale, y: size.h / 2 - v.cy * scale, scale }
}

export type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>

export const viewKey = (boardName: string) => `wirebender:view:${boardName}`

/**
 * The stored text as a view; null unless it has finite cx, cy and a positive zoom. The old
 * {x, y, scale} format (px of one window size) is dropped: the board is fitted instead.
 */
export function parseView(raw: string | null): StoredView | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const { cx, cy, zoom } = v as Record<string, unknown>
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  if (!num(cx) || !num(cy) || !num(zoom) || zoom <= 0) return null
  return { cx, cy, zoom }
}

/** `storage` is a getter because reading `window.localStorage` itself can throw. */
export function loadView(boardName: string, storage: () => ViewStorage | null | undefined): StoredView | null {
  try {
    const s = storage()
    return s ? parseView(s.getItem(viewKey(boardName))) : null
  } catch {
    return null
  }
}

/** False when storage is missing or refuses it. */
export function saveView(boardName: string, view: StoredView, storage: () => ViewStorage | null | undefined): boolean {
  try {
    const s = storage()
    if (!s) return false
    s.setItem(viewKey(boardName), JSON.stringify({ cx: view.cx, cy: view.cy, zoom: view.zoom }))
    return true
  } catch {
    return false
  }
}
