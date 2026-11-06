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

// ---- Stored view, per board ----------------------------------------------------------

export type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>

export const viewKey = (boardName: string) => `wirebender:view:${boardName}`

/** The stored text as a camera; null unless it has finite x, y and a positive scale. */
export function parseView(raw: string | null): Camera | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const { x, y, scale } = v as Record<string, unknown>
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  if (!num(x) || !num(y) || !num(scale) || scale <= 0) return null
  return { x, y, scale }
}

/** `storage` is a getter because reading `window.localStorage` itself can throw. */
export function loadView(boardName: string, storage: () => ViewStorage | null | undefined): Camera | null {
  try {
    const s = storage()
    return s ? parseView(s.getItem(viewKey(boardName))) : null
  } catch {
    return null
  }
}

/** False when storage is missing or refuses it. */
export function saveView(boardName: string, view: Camera, storage: () => ViewStorage | null | undefined): boolean {
  try {
    const s = storage()
    if (!s) return false
    s.setItem(viewKey(boardName), JSON.stringify({ x: view.x, y: view.y, scale: view.scale }))
    return true
  } catch {
    return false
  }
}
