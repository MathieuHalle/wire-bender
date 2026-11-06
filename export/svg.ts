// SVG drawings for the bench sheet. Everything meant to be laid on is drawn at 1:1:
// width/height in mm, viewBox in mm, strokes in mm. Pure: strings in, strings out.
// Text is never mirrored: bottom-side drawings mirror the geometry (x -> width - x) and
// place upright labels at the mirrored positions.
import { holeMm, holeName, parseHole, pathHoles, type Hole } from '../core/holes'
import { placePart, type PlacedPart } from '../core/footprints'
import { wireCards, type WireCard } from '../core/bench/cards'
import type { LegFoldRow } from '../core/bench/sheet'
import type { BoardFile, Side } from '../core/schema'

export const COPPER = '#b87333'
export const INSULATED_FALLBACK = '#1f6fb2'
const INK = '#16201b'
const MUTED = '#5b6a62'
const HOLE = '#8a968f'
const FONT = '-apple-system, \'Segoe UI\', Helvetica, Arial, sans-serif'
/** Smallest text in any drawing, mm. */
const MIN_FONT = 2.2
/** Rows of a split bend drawing stay under this height (letter printable height minus a card header). */
const MAX_ROW_HEIGHT_MM = 200

type Pt = { x: number, y: number }

// ---- small helpers -------------------------------------------------------------------

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Short decimal for coordinates: 3 places, no -0. */
function n(x: number): string {
  const v = Math.round(x * 1000) / 1000
  return String(v === 0 ? 0 : v)
}

/** A length already rounded by the model (the cut), printed without float noise. */
export function mmExact(x: number): string {
  return `${n(x)} mm`
}

/** Lengths shown to the owner: rounded to 0.5 mm. */
export function mmText(x: number): string {
  return `${n(Math.round(x * 2) / 2)} mm`
}

/** A colour from the board file, or the fallback when it is not a plain colour. */
export function safeColor(c: string | null | undefined, fallback: string): string {
  if (!c) return fallback
  return /^#[0-9a-f]{3,8}$/i.test(c) || /^[a-z]{3,20}$/i.test(c) ? c : fallback
}

/** Rough text width in mm for the system sans stack (wide enough for digits and capitals). */
function textW(s: string, size: number): number {
  return [...s].length * size * 0.6
}

// ---- a tiny scene: primitives with numeric coords, bounds, then one offset at render ----

type Anchor = 'start' | 'middle' | 'end'
type Prim
  = | { t: 'line', x1: number, y1: number, x2: number, y2: number, a: string }
    | { t: 'circle', cx: number, cy: number, r: number, a: string }
    | { t: 'rect', x: number, y: number, w: number, h: number, a: string }
    | { t: 'poly', pts: Pt[], a: string }
    | { t: 'text', x: number, y: number, s: string, size: number, anchor: Anchor, a: string }

interface Box { x0: number, y0: number, x1: number, y1: number }

class Scene {
  prims: Prim[] = []
  line(a: Pt, b: Pt, attrs: string) {
    this.prims.push({ t: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, a: attrs })
  }

  circle(c: Pt, r: number, attrs: string) {
    this.prims.push({ t: 'circle', cx: c.x, cy: c.y, r, a: attrs })
  }

  rect(x: number, y: number, w: number, h: number, attrs: string) {
    this.prims.push({ t: 'rect', x, y, w, h, a: attrs })
  }

  poly(pts: Pt[], attrs: string) {
    this.prims.push({ t: 'poly', pts, a: attrs })
  }

  /** `s` is plain text; it is escaped at render. */
  text(p: Pt, s: string, size: number, anchor: Anchor = 'start', attrs = '') {
    this.prims.push({ t: 'text', x: p.x, y: p.y, s, size: Math.max(MIN_FONT, size), anchor, a: attrs })
  }

  bounds(): Box {
    const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    const add = (x0: number, y0: number, x1: number, y1: number) => {
      b.x0 = Math.min(b.x0, x0)
      b.y0 = Math.min(b.y0, y0)
      b.x1 = Math.max(b.x1, x1)
      b.y1 = Math.max(b.y1, y1)
    }
    for (const p of this.prims) {
      if (p.t === 'line') add(Math.min(p.x1, p.x2), Math.min(p.y1, p.y2), Math.max(p.x1, p.x2), Math.max(p.y1, p.y2))
      else if (p.t === 'circle') add(p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r)
      else if (p.t === 'rect') add(p.x, p.y, p.x + p.w, p.y + p.h)
      else if (p.t === 'poly') for (const q of p.pts) add(q.x, q.y, q.x, q.y)
      else {
        const w = textW(p.s, p.size)
        const x0 = p.anchor === 'start' ? p.x : p.anchor === 'end' ? p.x - w : p.x - w / 2
        add(x0, p.y - p.size * 0.8, x0 + w, p.y + p.size * 0.25)
      }
    }
    if (!Number.isFinite(b.x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 }
    return b
  }

  /** The svg, every coordinate shifted by (dx, dy), at `w` x `h` mm. */
  render(w: number, h: number, dx: number, dy: number, label: string): string {
    const X = (x: number) => n(x + dx)
    const Y = (y: number) => n(y + dy)
    const body = this.prims.map((p) => {
      switch (p.t) {
        case 'line': return `<line ${p.a} x1="${X(p.x1)}" y1="${Y(p.y1)}" x2="${X(p.x2)}" y2="${Y(p.y2)}"/>`
        case 'circle': return `<circle ${p.a} cx="${X(p.cx)}" cy="${Y(p.cy)}" r="${n(p.r)}"/>`
        case 'rect': return `<rect ${p.a} x="${X(p.x)}" y="${Y(p.y)}" width="${n(p.w)}" height="${n(p.h)}"/>`
        case 'poly': return `<path ${p.a} d="${p.pts.map((q, i) => `${i ? 'L' : 'M'}${X(q.x)} ${Y(q.y)}`).join('')}"/>`
        case 'text': {
          const anchor = p.anchor === 'start' ? '' : ` text-anchor="${p.anchor}"`
          return `<text ${p.a} x="${X(p.x)}" y="${Y(p.y)}" font-size="${n(p.size)}"${anchor}>${esc(p.s)}</text>`
        }
      }
    }).join('')
    return `<svg width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}" font-family="${FONT}" fill="${INK}" role="img" aria-label="${esc(label)}">${body}</svg>`
  }

  /** Render fitted to its own bounds plus `pad` mm on every side (at least `minW` wide). */
  fit(pad: number, label: string, minW = 0): string {
    const b = this.bounds()
    const w = Math.max(minW, b.x1 - b.x0 + 2 * pad)
    return this.render(w, b.y1 - b.y0 + 2 * pad, pad - b.x0, pad - b.y0, label)
  }
}

/** Text with a white halo so it reads over copper and holes. */
const HALO = 'paint-order="stroke" stroke="#ffffff" stroke-width="0.6" stroke-linejoin="round"'

/** Draw a wire stretch: a dark edge under the colour so light insulation still prints. */
function wireStroke(s: Scene, a: Pt, b: Pt, color: string, width = 0.8, extra = '') {
  s.line(a, b, `stroke="#2b2f2d" stroke-width="${n(width + 0.3)}" stroke-linecap="round"`)
  s.line(a, b, `stroke="${color}" stroke-width="${n(width)}" stroke-linecap="round"${extra}`)
}

// ---- scale bar -------------------------------------------------------------------------

export const SCALE_LABEL = '10 mm — measure to check print scale'

export function scaleBarSvg(): string {
  const s = new Scene()
  s.line({ x: 1, y: 3 }, { x: 11, y: 3 }, `stroke="${INK}" stroke-width="0.35"`)
  s.line({ x: 1, y: 1.6 }, { x: 1, y: 4.4 }, `stroke="${INK}" stroke-width="0.25"`)
  s.line({ x: 11, y: 1.6 }, { x: 11, y: 4.4 }, `stroke="${INK}" stroke-width="0.25"`)
  s.text({ x: 13, y: 4 }, SCALE_LABEL, 2.6)
  const w = 13 + textW(SCALE_LABEL, 2.6) + 1
  return s.render(w, 6, 0, 0, 'scale bar, 10 mm')
}

// ---- board overview --------------------------------------------------------------------

/** Board mm -> drawing mm for one side (bottom mirrored as seen from below). */
function sideGeo(board: BoardFile, side: Side) {
  const pitch = board.board.pitchMm
  const span = (board.board.cols - 1) * pitch
  const mirrored = side === 'bottom'
  const x = (v: number) => (mirrored ? span - v : v)
  return {
    pitch,
    span,
    mirrored,
    x,
    pt(h: Hole): Pt {
      const m = holeMm(h, pitch)
      return { x: x(m.x), y: m.y }
    },
    rect(r: { x: number, y: number, w: number, h: number }) {
      return { x: mirrored ? span - r.x - r.w : r.x, y: r.y, w: r.w, h: r.h }
    }
  }
}

const rowLetters = (row: number) => holeName({ col: 1, row }).replace(/\d+$/, '')

function partMarks(s: Scene, pp: PlacedPart, g: ReturnType<typeof sideGeo>) {
  const pitch = g.pitch
  const mm = (h: Hole) => holeMm(h, pitch)
  const v = (q: Pt): Pt => ({ x: g.x(q.x), y: q.y })
  const r = pp.bodyRectMm
  const centre = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  const round = !!(pp.part.standing && pp.fp.twoLead)
  const pins = pp.pins.map(p => mm(p.hole))
  if (pp.fp.mark === 'pin1') {
    const p1 = mm(pp.pins.find(x => x.name === '1')?.hole ?? pp.pins[0]!.hole)
    const dx = centre.x - p1.x
    const dy = centre.y - p1.y
    const len = Math.hypot(dx, dy) || 1
    s.circle(v({ x: p1.x + (dx / len) * 1.6, y: p1.y + (dy / len) * 1.6 }), 0.45, `fill="${INK}"`)
  } else if ((pp.fp.mark === 'tab' || pp.fp.mark === 'flat') && !round) {
    const cx = pins.reduce((a, q) => a + q.x, 0) / pins.length
    const cy = pins.reduce((a, q) => a + q.y, 0) / pins.length
    const i = 0.3
    const edges: [Pt, Pt][] = [
      [{ x: r.x + i, y: r.y + i }, { x: r.x + r.w - i, y: r.y + i }],
      [{ x: r.x + i, y: r.y + r.h - i }, { x: r.x + r.w - i, y: r.y + r.h - i }],
      [{ x: r.x + i, y: r.y + i }, { x: r.x + i, y: r.y + r.h - i }],
      [{ x: r.x + r.w - i, y: r.y + i }, { x: r.x + r.w - i, y: r.y + r.h - i }]
    ]
    const d = (e: [Pt, Pt]) => Math.hypot((e[0].x + e[1].x) / 2 - cx, (e[0].y + e[1].y) / 2 - cy)
    const far = edges.reduce((best, e) => (d(e) > d(best) ? e : best))
    s.line(v(far[0]), v(far[1]), `stroke="${pp.fp.mark === 'tab' ? '#8d969b' : INK}" stroke-width="${pp.fp.mark === 'tab' ? 0.9 : 0.35}" stroke-linecap="round"`)
  } else if (pp.fp.mark === 'stripe-b' && pins.length === 2) {
    const [a, b] = pins as [Pt, Pt]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    const nrm = { x: -u.y, y: u.x }
    if (round) {
      const c = { x: b.x - u.x * 0.9, y: b.y - u.y * 0.9 }
      s.line(v({ x: c.x + nrm.x * 0.8, y: c.y + nrm.y * 0.8 }), v({ x: c.x - nrm.x * 0.8, y: c.y - nrm.y * 0.8 }), `stroke="${INK}" stroke-width="0.45"`)
    } else {
      const half = pp.fp.body.rect.h / 2
      const c = { x: centre.x + u.x * pp.fp.body.rect.w * 0.3, y: centre.y + u.y * pp.fp.body.rect.w * 0.3 }
      s.line(v({ x: c.x + nrm.x * half, y: c.y + nrm.y * half }), v({ x: c.x - nrm.x * half, y: c.y - nrm.y * half }), `stroke="#3b3f42" stroke-width="0.7"`)
    }
  }
}

/**
 * The whole board at 1:1 from one side: hole grid with row/column names, part bodies
 * (solid on top, dashed on the bottom) with refs, that side's trails and wires, wire
 * ends and joints, solder bridges and (bottom) leg-folds. The bottom is mirrored.
 */
export function boardOverviewSvg(board: BoardFile, side: Side): string {
  const s = new Scene()
  const g = sideGeo(board, side)
  const { cols, rows } = board.board
  const p = g.pitch
  const half = p / 2
  const height = (rows - 1) * p

  // board and holes
  s.rect(-half, -half, g.span + p, height + p, `rx="0.6" fill="#f4f8f5" stroke="#9fb5a6" stroke-width="0.25"`)
  for (let row = 1; row <= rows; row++)
    for (let col = 1; col <= cols; col++)
      s.circle(g.pt({ col, row }), 0.5, `fill="#ffffff" stroke="${HOLE}" stroke-width="0.18"`)
  for (const bl of board.board.blocked)
    for (const h of bl.holes) {
      const c = g.pt(parseHole(h))
      s.line({ x: c.x - 0.8, y: c.y - 0.8 }, { x: c.x + 0.8, y: c.y + 0.8 }, `stroke="#c8321e" stroke-width="0.25"`)
      s.line({ x: c.x - 0.8, y: c.y + 0.8 }, { x: c.x + 0.8, y: c.y - 0.8 }, `stroke="#c8321e" stroke-width="0.25"`)
    }

  // column numbers staggered on two lines (odd outer, even inner) above and below; row letters both sides
  const lab = `fill="${MUTED}"`
  for (let col = 1; col <= cols; col++) {
    const x = g.pt({ col, row: 1 }).x
    const outer = col % 2 === 1
    s.text({ x, y: -half - (outer ? 3.6 : 0.9) }, String(col), MIN_FONT, 'middle', `data-col="${col}" ${lab}`)
    s.text({ x, y: height + half + (outer ? 5.2 : 2.5) }, String(col), MIN_FONT, 'middle', lab)
  }
  for (let row = 1; row <= rows; row++) {
    const y = (row - 1) * p + 0.8
    s.text({ x: -half - 0.8, y }, rowLetters(row), MIN_FONT, 'end', lab)
    s.text({ x: g.span + half + 0.8, y }, rowLetters(row), MIN_FONT, 'start', lab)
  }

  // part bodies
  const placed = board.parts.map(placePart)
  for (const pp of placed) {
    const round = !!(pp.part.standing && pp.fp.twoLead)
    const r = g.rect(pp.bodyRectMm)
    const bodyAttrs = side === 'top'
      ? `fill="#ffffff" fill-opacity="0.85" stroke="${INK}" stroke-width="0.22"`
      : `fill="none" stroke="${INK}" stroke-opacity="0.6" stroke-width="0.2" stroke-dasharray="0.7 0.45"`
    if (side === 'top' && pp.fp.twoLead && pp.pins.length === 2)
      s.line(g.pt(pp.pins[0]!.hole), g.pt(pp.pins[1]!.hole), `stroke="#8d969b" stroke-width="0.5" stroke-linecap="round"`)
    if (round) s.circle({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, r.w / 2, bodyAttrs)
    else s.rect(r.x, r.y, r.w, r.h, `rx="0.4" ${bodyAttrs}`)
    if (side === 'top') partMarks(s, pp, g)
  }
  // leads: pins on top, lead ends on the solder side
  for (const pp of placed)
    for (const pin of pp.pins) s.circle(g.pt(pin.hole), 0.45, `fill="#4b555b"`)

  // copper of this side
  const blob = (c: Pt, color: string) => s.circle(c, 0.95, `fill="${color}" stroke="#000000" stroke-opacity="0.35" stroke-width="0.12"`)
  const ids: { at: Pt, id: string }[] = []
  const cardColor = new Map(wireCards(board).map(c => [`${c.kind === 'trail' ? 't' : 'w'}:${c.id}`, c.color]))
  for (const t of board.trails) {
    if (t.side !== side || t.points.length === 0) continue
    const pts = t.points.map(parseHole)
    const core = cardColor.get(`t:${t.id}`) ? safeColor(cardColor.get(`t:${t.id}`), COPPER) : null
    s.poly(pts.map(g.pt), `data-trail="${esc(t.id)}" fill="none" stroke="${COPPER}" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"`)
    if (core) s.poly(pts.map(g.pt), `fill="none" stroke="${core}" stroke-width="0.3"`)
    const joints = new Map([pts[0]!, pts[pts.length - 1]!, ...t.joints.map(parseHole)].map(h => [`${h.col},${h.row}`, h]))
    for (const h of joints.values()) blob(g.pt(h), COPPER)
    ids.push({ at: longestMid(pts.map(g.pt)), id: t.id })
  }
  for (const w of board.wires) {
    if (w.side !== side) continue
    const pts = w.points.map(parseHole).map(g.pt)
    const color = safeColor(cardColor.get(`w:${w.id}`), INSULATED_FALLBACK)
    if (w.kind === 'flying') {
      const a = pts[0]!
      const b = pts[pts.length - 1]!
      s.line(a, b, `data-wire="${esc(w.id)}" stroke="${color}" stroke-width="0.6" stroke-dasharray="1.6 0.8" stroke-linecap="round"`)
      blob(a, color)
      blob(b, color)
      ids.push({ at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, id: w.id })
    } else {
      for (let i = 0; i + 1 < pts.length; i++)
        wireStroke(s, pts[i]!, pts[i + 1]!, w.bareSegments.includes(i) ? COPPER : color, 0.7, ` data-wire="${esc(w.id)}"`)
      for (const h of [pts[0]!, pts[pts.length - 1]!, ...w.joints.map(j => g.pt(parseHole(j)))]) blob(h, color)
      ids.push({ at: longestMid(pts), id: w.id })
    }
  }
  for (const b of board.solderBridges) {
    if (b.side !== side) continue
    s.line(g.pt(parseHole(b.a)), g.pt(parseHole(b.b)), `stroke="#7c868c" stroke-width="1.7" stroke-linecap="round"`)
  }
  if (side === 'bottom') {
    const leadHole = new Map<string, Hole>()
    for (const pp of placed) for (const pin of pp.pins) leadHole.set(`${pp.part.ref}.${pin.name}`, pin.hole)
    for (const f of board.legFolds) {
      const from = leadHole.get(f.lead)
      if (!from) continue
      const a = g.pt(from)
      const b = g.pt(parseHole(f.to))
      s.line(a, b, `stroke="#4b555b" stroke-width="0.7" stroke-linecap="round"`)
      blob(b, COPPER)
    }
  }

  // labels last, over everything: part refs at body centres, trail/wire ids
  for (const pp of placed) {
    const r = g.rect(pp.bodyRectMm)
    s.text({ x: r.x + r.w / 2, y: r.y + r.h / 2 + 0.8 }, pp.part.ref, MIN_FONT, 'middle', `font-weight="600" ${HALO}`)
  }
  for (const l of ids) s.text({ x: l.at.x, y: l.at.y - 0.9 }, l.id, MIN_FONT, 'middle', `fill="#7a3f12" ${HALO}`)

  const title = side === 'top' ? 'TOP — parts side' : 'BOTTOM — solder side (board turned over)'
  const b = s.bounds()
  s.text({ x: b.x0, y: b.y0 - 1.4 }, `${board.name}: ${title}`, 2.8, 'start', 'font-weight="700"')
  return s.fit(1, `${board.name}, ${title}, 1:1`)
}

/** Midpoint of the longest straight run of a polyline (where its id label goes). */
function longestMid(pts: Pt[]): Pt {
  let best = { len: -1, at: pts[0]! }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len > best.len) best = { len, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  }
  return best.at
}

// ---- label placement --------------------------------------------------------------------

/** A label of size w x h (mm) drawn with its top-left corner at (x, y). */
interface Block { w: number, h: number, draw: (x: number, y: number) => void }

/** The 8 compass directions, best first by how well they match `o`. */
function prefer(o: Pt): Pt[] {
  const d = Math.SQRT1_2
  const all = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }, { x: d, y: d }, { x: d, y: -d }, { x: -d, y: d }, { x: -d, y: -d }]
  const l = Math.hypot(o.x, o.y) || 1
  const head = { x: o.x / l, y: o.y / l }
  return [head, ...all.sort((a, b) => (b.x * o.x + b.y * o.y) - (a.x * o.x + a.y * o.y))]
}

/** Greedy label placement: each label takes the first spot that hits nothing placed before. */
class Placer {
  boxes: Box[] = []
  segment(a: Pt, b: Pt, r: number) {
    this.boxes.push({ x0: Math.min(a.x, b.x) - r, y0: Math.min(a.y, b.y) - r, x1: Math.max(a.x, b.x) + r, y1: Math.max(a.y, b.y) + r })
  }

  circle(c: Pt, r: number) {
    this.boxes.push({ x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r })
  }

  hit(r: Box): boolean {
    return this.boxes.some(b => r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0)
  }

  /** Try each distance, then each direction; a far label gets a thin leader line to its anchor. */
  place(at: Pt, dirs: Pt[], dists: number[], block: Block, s: Scene) {
    const rectAt = (dir: Pt, d: number): Box => {
      const cx = at.x + dir.x * d
      const cy = at.y + dir.y * d
      const x0 = dir.x > 0.3 ? cx : dir.x < -0.3 ? cx - block.w : cx - block.w / 2
      const y0 = dir.y > 0.3 ? cy : dir.y < -0.3 ? cy - block.h : cy - block.h / 2
      return { x0, y0, x1: x0 + block.w, y1: y0 + block.h }
    }
    let chosen: { r: Box, d: number } | null = null
    for (const d of dists) {
      for (const dir of dirs) {
        const r = rectAt(dir, d)
        if (!this.hit(r)) {
          chosen = { r, d }
          break
        }
      }
      if (chosen) break
    }
    chosen ??= { r: rectAt(dirs[0]!, dists[0]!), d: dists[0]! }
    const { r, d } = chosen
    const q = { x: Math.min(Math.max(at.x, r.x0), r.x1), y: Math.min(Math.max(at.y, r.y0), r.y1) }
    if (d > 2 && Math.hypot(q.x - at.x, q.y - at.y) > 1.5) s.line(at, q, `stroke="${MUTED}" stroke-width="0.2"`)
    this.boxes.push({ x0: r.x0 - 0.3, y0: r.y0 - 0.2, x1: r.x1 + 0.3, y1: r.y1 + 0.2 })
    block.draw(r.x0, r.y0)
  }
}

// ---- bend drawing ----------------------------------------------------------------------

/** A straight piece of a wire in drawing mm; a long segment may be cut into several pieces. */
interface Piece { a: Pt, b: Pt, ha: Hole, hb: Hole, bare: boolean }

function sideLabel(side: Side): string {
  return side === 'bottom' ? 'seen from the solder side (board turned over)' : 'seen from the parts side'
}

const unit = (a: Pt, b: Pt): Pt => {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
}
const same = (u: Pt, v: Pt) => Math.abs(u.x - v.x) < 1e-9 && Math.abs(u.y - v.y) < 1e-9

interface RowCtx {
  card: WireCard
  color: string
  firstRow: boolean
  lastRow: boolean
  rowIndex: number
  rowCount: number
  /** Dashed 1:1 lead stubs, mm: `start` on the first row, `end` (lead + spare + rounding) on the last. */
  leads: { start: number, end: number }
}

export const START_LEAD_LABEL = 'lead: bend down into the hole'
export const END_LEAD_LABEL = 'lead + spare: trim after soldering'
export const SPARE_TAIL_LABEL = 'longer tail = spare, trim after soldering'
/** The lead labels on two lines, so they stay narrow beside a short stub. */
const LABEL_LINES: Record<string, string[]> = {
  [START_LEAD_LABEL]: ['lead: bend down', 'into the hole'],
  [END_LEAD_LABEL]: ['lead + spare:', 'trim after soldering'],
  [SPARE_TAIL_LABEL]: ['longer tail = spare,', 'trim after soldering']
}

/** Lay out one row of a bend drawing in drawing mm (unshifted). */
function rowScene(pieces: Piece[], ctx: RowCtx, bendOf: (i: number) => RowBend | undefined): Scene {
  const s = new Scene()
  const { card, color } = ctx
  const pts = [pieces[0]!.a, ...pieces.map(p => p.b)]
  const centroid = {
    x: pts.reduce((a, q) => a + q.x, 0) / pts.length,
    y: pts.reduce((a, q) => a + q.y, 0) / pts.length
  }
  const pitch = card.pitchMm

  // holes along the wire, under it
  for (const p of pieces) {
    const steps = Math.round(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) / pitch)
    const u = unit(p.a, p.b)
    for (let k = 0; k <= steps; k++)
      s.circle({ x: p.a.x + u.x * k * pitch, y: p.a.y + u.y * k * pitch }, 0.95, `fill="none" stroke="${HOLE}" stroke-width="0.15"`)
  }
  // the wire
  pieces.forEach((p, i) => wireStroke(s, p.a, p.b, p.bare ? COPPER : color, 0.8, ` data-piece="${i}"`))

  // Labels are placed one by one on the first free spot near their anchor (wire, end
  // circles and earlier labels are obstacles), preferring the outside of the shape.
  const placer = new Placer()
  for (const p of pieces) placer.segment(p.a, p.b, 0.9)

  // The leads at 1:1, dashed, straight on from the end holes: the cut end of the wire lines up
  // with the far end of the start stub; the end stub holds the end lead, spare and rounding.
  const first = pieces[0]!
  const last = pieces[pieces.length - 1]!
  const u0 = unit(first.a, first.b)
  const u1 = unit(last.a, last.b)
  const stubs: { at: Pt, dir: Pt, len: number, role: 'start' | 'end', label: string }[] = []
  if (ctx.firstRow && ctx.leads.start > 0)
    stubs.push({ at: first.a, dir: { x: -u0.x, y: -u0.y }, len: ctx.leads.start, role: 'start', label: START_LEAD_LABEL })
  if (ctx.lastRow && ctx.leads.end > 0)
    stubs.push({ at: last.b, dir: u1, len: ctx.leads.end, role: 'end', label: card.kind === 'trail' ? SPARE_TAIL_LABEL : END_LEAD_LABEL })
  for (const st of stubs) {
    const far = { x: st.at.x + st.dir.x * st.len, y: st.at.y + st.dir.y * st.len }
    s.line(st.at, far, `stroke="#2b2f2d" stroke-width="1.1" stroke-dasharray="1.2 0.8" stroke-linecap="butt"`)
    s.line(st.at, far, `data-lead="${st.role}" stroke="${COPPER}" stroke-width="0.8" stroke-dasharray="1.2 0.8" stroke-linecap="butt"`)
    // the cut end: a short tick across the stub
    const nrm = { x: -st.dir.y, y: st.dir.x }
    const t1 = { x: far.x + nrm.x * 1.4, y: far.y + nrm.y * 1.4 }
    const t2 = { x: far.x - nrm.x * 1.4, y: far.y - nrm.y * 1.4 }
    s.line(t1, t2, `stroke="${INK}" stroke-width="0.3"`)
    placer.segment(st.at, far, 0.9)
    placer.segment(t1, t2, 0.3)
  }
  const outward = (q: Pt): Pt => {
    const d = { x: q.x - centroid.x, y: q.y - centroid.y }
    const l = Math.hypot(d.x, d.y)
    return l < 1e-9 ? { x: 0, y: -1 } : { x: d.x / l, y: d.y / l }
  }
  const bold = `font-weight="600" ${HALO}`
  const textBlock = (str: string, size: number, attrs: string): Block => ({
    w: textW(str, size), h: size * 1.05,
    draw: (x, y) => s.text({ x, y: y + size * 0.8 }, str, size, 'start', attrs)
  })

  // ends first: the wire's start and end holes, or the split points between rows
  const ends: { at: Pt, away: Pt, str: string, role: string | null }[] = [
    { at: first.a, away: { x: -u0.x, y: -u0.y }, role: ctx.firstRow ? 'start' : null,
      str: ctx.firstRow ? `start ${card.start}` : `◂ continued from row ${ctx.rowIndex} at ${holeName(first.ha)}` },
    { at: last.b, away: u1, role: ctx.lastRow ? 'end' : null,
      str: ctx.lastRow ? `end ${card.end}` : `continues ▸ row ${ctx.rowIndex + 2} at ${holeName(last.hb)}` }
  ]
  for (const e of ends) {
    if (e.role) {
      s.circle(e.at, 1.1, `data-role="${e.role}" fill="#ffffff" stroke="${INK}" stroke-width="0.35"`)
      placer.circle(e.at, 1.3)
    } else {
      // a split between rows: the same hole ends one row and starts the next
      s.circle(e.at, 1.1, `data-role="split" fill="none" stroke="${INK}" stroke-width="0.25" stroke-dasharray="0.5 0.35"`)
      placer.circle(e.at, 1.3)
    }
  }
  for (const e of ends) placer.place(e.at, prefer(e.away), [1.8, 3.5, 5.5], textBlock(e.str, 2.6, `${e.role ? 'font-weight="700" ' : ''}${HALO}`), s)
  // lead labels beside their stub, outside the shape when there is room
  for (const st of stubs) {
    const mid = { x: st.at.x + st.dir.x * st.len / 2, y: st.at.y + st.dir.y * st.len / 2 }
    let nrm = { x: -st.dir.y, y: st.dir.x }
    const o = outward(mid)
    if (nrm.x * o.x + nrm.y * o.y < 0) nrm = { x: -nrm.x, y: -nrm.y }
    const ls = LABEL_LINES[st.label] ?? [st.label]
    const size = 2.4
    placer.place(mid, [nrm, { x: -nrm.x, y: -nrm.y }, ...prefer(st.dir)], [1.3, 2.8, 4.5, 6.5], {
      w: Math.max(...ls.map(l => textW(l, size))), h: ls.length * size * 1.15,
      draw: (x, y) => ls.forEach((l, k) => s.text({ x, y: y + size * 0.8 + k * size * 1.15 }, l, size, 'start', `font-style="italic" ${HALO}`))
    }, s)
  }

  // bends: numbered, angle and direction, on the outside of the corner
  for (let i = 0; i < pieces.length; i++) {
    const bend = bendOf(i)
    if (!bend) continue
    const at = pieces[i]!.a
    const prev = pieces[i - 1]
    const v = unit(pieces[i]!.a, pieces[i]!.b)
    // incoming direction: from the previous piece, or (row start) carried over from the split
    const u = prev ? unit(prev.a, prev.b) : bend.incoming
    const ox = u.x - v.x
    const oy = u.y - v.y
    const ol = Math.hypot(ox, oy) || 1
    const what = bend.angleDeg === 180 ? '180° back' : `90° ${bend.dir}`
    const tw = textW(what, 2.6)
    placer.place(at, prefer({ x: ox / ol, y: oy / ol }), [2.2, 3.8, 5.6, 8], {
      w: 3.4 + tw, h: 3.2,
      draw: (x, y) => {
        s.circle({ x: x + 1.5, y: y + 1.6 }, 1.5, `fill="${INK}"`)
        s.text({ x: x + 1.5, y: y + 2.4 }, String(bend.index), MIN_FONT, 'middle', 'fill="#ffffff" font-weight="700"')
        s.text({ x: x + 3.4, y: y + 2.5 }, what, 2.6, 'start', bold)
      }
    }, s)
  }

  // segment lengths, beside their piece
  for (const p of pieces) {
    const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y)
    const m = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }
    const u = unit(p.a, p.b)
    let nrm = { x: -u.y, y: u.x }
    const o = outward(m)
    if (nrm.x * o.x + nrm.y * o.y < 0 || (pieces.length === 1 && nrm.y > 0)) nrm = { x: -nrm.x, y: -nrm.y }
    const dirs = [nrm, { x: -nrm.x, y: -nrm.y }, ...prefer(nrm).slice(1)]
    placer.place(m, dirs, [1.3, 2.8, 4.5, 6.5], textBlock(mmText(len) + (p.bare ? ' bare' : ''), 2.6, bold), s)
  }

  // header
  const b = s.bounds()
  const rowTag = ctx.rowCount > 1 ? ` (row ${ctx.rowIndex + 1} of ${ctx.rowCount})` : ''
  // bottom drawings are mirrored: the header hangs from the right, where the board's column 1 is
  const right = card.side === 'bottom'
  s.text({ x: right ? b.x1 : b.x0, y: b.y0 - 1.6 }, `${card.id}${rowTag} — ${sideLabel(card.side)}`, 2.6, right ? 'end' : 'start', `font-weight="700"`)
  return s
}

type RowBend = WireCard['bends'][number] & { incoming: Pt }

/**
 * The 1:1 shape of a trail or laid wire, as one or more SVGs no wider than `maxWidthMm`.
 * A long wire is split into rows at a bend when that fits, else at a hole along a long run;
 * each split is marked "continues ▸" / "◂ continued". Flying wires have no drawing ([]).
 */
export function bendSvgs(card: WireCard, maxWidthMm = 180): string[] {
  if (card.kind === 'flying' || card.segments.length === 0) return []
  const color = safeColor(card.color, INSULATED_FALLBACK)
  const mirror = card.side === 'bottom' ? -1 : 1
  const draw = (h: Hole): Pt => {
    const m = holeMm(h, card.pitchMm)
    return { x: mirror * m.x, y: m.y }
  }
  // Drawn wire = cut minus the bend allowances: start lead + path + end lead, spare and rounding.
  const startLead = card.breakdown.leadsMm / 2
  const leads = { start: startLead, end: card.cutMm - card.breakdown.bendsMm - card.breakdown.pathMm - startLead }

  // Bends by segment boundary: the card's bends in order, at boundaries where the direction turns.
  const segs = card.segments.map(sg => ({ ha: parseHole(sg.from), hb: parseHole(sg.to), bare: sg.bare }))
  const bendBefore = new Map<number, RowBend>() // segment index -> bend at its start
  let bi = 0
  for (let i = 1; i < segs.length; i++) {
    const u = unit(draw(segs[i - 1]!.ha), draw(segs[i - 1]!.hb))
    const v = unit(draw(segs[i]!.ha), draw(segs[i]!.hb))
    if (same(u, v)) continue
    const bend = card.bends[bi++]
    if (bend) bendBefore.set(i, { ...bend, incoming: u })
  }

  // Greedy rows; pieces remember whether they start at a bend.
  type P = Piece & { bend?: RowBend }
  const lastSeg = segs.length - 1
  /** `final`: the row ends at the wire's end, so it carries the end lead. */
  const fits = (row: P[], rowIndex: number, final: boolean) => {
    const sc = rowScene(row, { card, color, firstRow: rowIndex === 0, lastRow: final, rowIndex, rowCount: 2, leads }, i => row[i]!.bend)
    const b = sc.bounds()
    return b.x1 - b.x0 + 2 <= maxWidthMm && b.y1 - b.y0 + 2 <= MAX_ROW_HEIGHT_MM
  }
  const rows: P[][] = []
  let cur: P[] = []
  segs.forEach((sg, i) => {
    let ha = sg.ha
    let bend = bendBefore.get(i)
    for (;;) {
      const whole: P = { a: draw(ha), b: draw(sg.hb), ha, hb: sg.hb, bare: sg.bare, ...(bend ? { bend } : {}) }
      if (fits([...cur, whole], rows.length, i === lastSeg)) {
        cur.push(whole)
        return
      }
      if (cur.length) {
        rows.push(cur)
        cur = []
        continue
      }
      // A single run too long for the row: cut it at the farthest hole that still fits.
      const run = pathHoles([ha, sg.hb])
      let k = 1
      while (k + 1 < run.length - 1) {
        const hb = run[k + 1]!
        if (!fits([{ ...whole, b: draw(hb), hb }], rows.length, false)) break
        k++
      }
      const hb = run[k]!
      if (k === run.length - 1) {
        // one hole step that does not fit even alone: draw it as it is rather than loop
        cur.push(whole)
        return
      }
      rows.push([{ ...whole, b: draw(hb), hb }])
      // the next row carries straight on: no bend at the cut
      ha = hb
      bend = undefined
    }
  })
  if (cur.length) rows.push(cur)

  return rows.map((row, r) => {
    const sc = rowScene(row, {
      card, color, firstRow: r === 0, lastRow: r === rows.length - 1, rowIndex: r, rowCount: rows.length, leads
    }, i => row[i]!.bend)
    const tag = rows.length > 1 ? `, row ${r + 1} of ${rows.length}` : ''
    return sc.fit(1, `${card.id} bend drawing at 1:1${tag}, ${sideLabel(card.side)}`)
  })
}

// ---- strip bar -------------------------------------------------------------------------

/**
 * The cut wire as a bar `widthMm` wide (NOT 1:1): bare and insulated stretches with their
 * lengths, and a ✂ mark with "strip at X mm" (from the start end) at every change.
 */
export function stripBarSvg(card: WireCard, widthMm: number): string {
  const s = new Scene()
  const color = safeColor(card.color, INSULATED_FALLBACK)
  const x0 = 1
  const x1 = widthMm - 1
  const total = card.cutMm || card.stretches.reduce((a, t) => a + t.lengthMm, 0) || 1
  const X = (mm: number) => x0 + (mm / total) * (x1 - x0)
  const barY = 8.6
  const barH = 4

  /** Put labels on the first free level (left-to-right extents), falling back to level 0. */
  const levels = (items: { x0: number, x1: number }[], count: number): number[] => {
    const ends: number[] = Array.from({ length: count }, () => -Infinity)
    return items.map((it) => {
      const lv = ends.findIndex(e => it.x0 > e + 1)
      const l = lv < 0 ? 0 : lv
      ends[l] = it.x1
      return l
    })
  }

  // stretches
  let pos = 0
  const lens: { x: number, s: string, x0: number, x1: number }[] = []
  for (const t of card.stretches) {
    const a = X(pos)
    const b = X(pos + t.lengthMm)
    s.rect(a, barY, b - a, barH, `fill="${t.bare ? COPPER : color}" stroke="#2b2f2d" stroke-width="0.2"`)
    const label = mmText(t.lengthMm) + (t.bare ? ' bare' : '')
    const w = textW(label, 2.4)
    const cx = Math.min(Math.max((a + b) / 2, x0 + w / 2), x1 - w / 2)
    lens.push({ x: cx, s: label, x0: cx - w / 2, x1: cx + w / 2 })
    pos += t.lengthMm
  }
  levels(lens, 2).forEach((l, i) => s.text({ x: lens[i]!.x, y: barY + barH + 3 + l * 2.9 }, lens[i]!.s, 2.4, 'middle'))

  // strip marks
  const marks = card.strip.map((m) => {
    const x = X(m.fromStartMm)
    const left = x < widthMm / 2
    const label = left ? `✂ strip at ${mmText(m.fromStartMm)}` : `strip at ${mmText(m.fromStartMm)} ✂`
    const w = textW(label, 2.4)
    const tx = left ? Math.max(x0, x - 1.3) : Math.min(x1, x + 1.3)
    return { x, tx, left, label, x0: left ? tx : tx - w, x1: left ? tx + w : tx }
  })
  levels(marks, 2).forEach((l, i) => {
    const m = marks[i]!
    const y = 5.4 - l * 2.8
    s.line({ x: m.x, y: y + 0.6 }, { x: m.x, y: barY + barH + 0.6 }, `stroke="${INK}" stroke-width="0.25" stroke-dasharray="0.6 0.4"`)
    s.text({ x: m.tx, y }, m.label, 2.4, m.left ? 'start' : 'end', `font-weight="600" ${HALO}`)
  })

  const endY = barY + barH + 3 + 2 * 2.9 + 0.4
  s.text({ x: x0, y: endY }, `start ${card.start}`, MIN_FONT, 'start', `fill="${MUTED}"`)
  s.text({ x: x1, y: endY }, `end ${card.end}`, MIN_FONT, 'end', `fill="${MUTED}"`)
  return s.render(widthMm, endY + 1.2, 0, 0, `${card.id} strip bar, cut ${mmText(total)}, not to scale`)
}

// ---- leg-fold sketch ---------------------------------------------------------------------

/** Sketch scale: the pad sketch is drawn at 3x so the hole names fit. */
const FOLD_SCALE = 3

/**
 * A 3 x 2 pad sketch (3x scale), solder side, mirrored like the bottom view: the lead
 * leaves its hole and lies flat on the target pad, soldered at both.
 */
export function legFoldSvg(row: LegFoldRow, pitchMm: number): string {
  const s = new Scene()
  const from = parseHole(row.from)
  const to = parseHole(row.to)
  const horizontal = Math.abs(to.col - from.col) >= Math.abs(to.row - from.row)
  // the sketch grid: along the fold 3 holes (or the whole span), across it 2
  const along = (a: number, b: number) => {
    let lo = Math.min(a, b)
    let hi = Math.max(a, b)
    while (hi - lo < 2) {
      if (lo > 1) lo--
      else hi++
    }
    return [lo, hi] as const
  }
  const across = (v: number) => (v > 1 ? [v - 1, v] : [v, v + 1]) as [number, number]
  const [c0, c1] = horizontal ? along(from.col, to.col) : across(from.col)
  const [r0, r1] = horizontal ? across(from.row) : along(from.row, to.row)
  const P = pitchMm * FOLD_SCALE
  const pt = (h: Hole): Pt => ({ x: -(h.col - c0) * P, y: (h.row - r0) * P }) // mirrored: solder side

  const names: { c: Pt, name: string }[] = []
  for (let row = r0; row <= r1; row++)
    for (let col = c0; col <= c1; col++) {
      const h = { col, row }
      const c = pt(h)
      s.circle(c, 0.85 * FOLD_SCALE, `fill="#e9d3bf" stroke="${COPPER}" stroke-width="0.35"`)
      s.circle(c, 0.4 * FOLD_SCALE, `fill="#ffffff" stroke="${HOLE}" stroke-width="0.2"`)
      names.push({ c, name: holeName(h) })
    }
  const a = pt(from)
  const b = pt(to)
  // the leg: from its hole, lying flat to the target pad; solder at both
  s.line(a, b, `stroke="#4b555b" stroke-width="1.5" stroke-linecap="round"`)
  s.line(a, b, `stroke="#c0c6ca" stroke-width="0.9" stroke-linecap="round"`)
  s.circle(a, 1.6, `fill="${COPPER}" fill-opacity="0.9" stroke="#2b2f2d" stroke-width="0.2"`)
  s.circle(b, 1.6, `fill="${COPPER}" fill-opacity="0.9" stroke="#2b2f2d" stroke-width="0.2"`)
  // each name sits up and right of its pad, clear of the neighbours and the leg
  const r = 0.85 * FOLD_SCALE
  for (const { c, name } of names) {
    const bold = name === row.from || name === row.to
    s.text({ x: c.x + r * 0.75, y: c.y - r * 0.75 }, name, MIN_FONT, 'start', bold ? `font-weight="700" ${HALO}` : `fill="${MUTED}" ${HALO}`)
  }
  const bx = s.bounds()
  s.text({ x: bx.x0, y: bx.y0 - 4.4 }, `${row.lead}: fold ${row.from} → ${row.to}`, 2.6, 'start', 'font-weight="700"')
  s.text({ x: bx.x0, y: bx.y0 - 1.2 }, 'solder side (board turned over), sketch 3×', MIN_FONT, 'start', `fill="${MUTED}"`)
  return s.fit(1, `leg-fold ${row.lead} from ${row.from} to ${row.to}, solder side sketch`)
}
