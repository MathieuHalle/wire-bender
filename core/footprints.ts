import { holeMm, parseHole, type Hole } from './holes'
import type { Part, PinRole } from './schema'

const PITCH = 2.54

export interface Footprint {
  id: string
  name: string
  /** Offsets in holes from pin 1, rotation 0. */
  pins: { name: string; dx: number; dy: number; role?: PinRole }[]
  /** Holes between `at` and `to`; pins are 'a' (at) and 'b' (to). */
  twoLead?: { minSpan: number; maxSpan: number }
  /**
   * Rotation 0, mm, relative to pin 1 centre; x right, y down. For twoLead parts
   * the rect is centred on the origin (the lead midpoint) with w along the lead axis.
   */
  body: { rect: { x: number; y: number; w: number; h: number }; heightMm: number; round?: boolean; side: 'top' }
  mark?: 'pin1' | 'stripe-b' | 'flat' | 'tab'
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface PlacedPart {
  part: Part
  fp: Footprint
  pins: { name: string; hole: Hole; net: string | null; role: PinRole }[]
  /** Holes under the body, excluding the part's own pins. */
  bodyHoles: Hole[]
  /** Board mm, after rotation/flip. */
  bodyRectMm: Rect
}

const p = (name: string, dx: number, dy: number) => ({ name, dx, dy })
/** Rect of size w x h centred on a pin box that spans bx x by holes. */
const centred = (bx: number, by: number, w: number, h: number): Rect => ({
  x: (bx * PITCH) / 2 - w / 2, y: (by * PITCH) / 2 - h / 2, w, h
})
const centredOrigin = (w: number, h: number): Rect => ({ x: -w / 2, y: -h / 2, w, h })

export const FOOTPRINTS: Record<string, Footprint> = {
  'relay-g5v2': {
    id: 'relay-g5v2', name: 'Relay G5V-2',
    pins: [p('1', 0, 0), p('16', 3, 0), p('4', 0, 3), p('13', 3, 3), p('6', 0, 5), p('11', 3, 5), p('8', 0, 7), p('9', 3, 7)],
    body: { rect: centred(3, 7, 10.1, 20.5), heightMm: 11.5, side: 'top' }, mark: 'pin1'
  },
  'to220-gds': {
    id: 'to220-gds', name: 'TO-220 (G D S)',
    pins: [p('G', 0, 0), p('D', 0, 1), p('S', 0, 2)],
    body: { rect: { x: 1.27, y: PITCH - 5, w: 4.5, h: 10.0 }, heightMm: 15.5, side: 'top' }, mark: 'tab'
  },
  dip8: {
    id: 'dip8', name: 'DIP-8',
    pins: [p('1', 0, 0), p('2', 0, 1), p('3', 0, 2), p('4', 0, 3), p('5', 3, 3), p('6', 3, 2), p('7', 3, 1), p('8', 3, 0)],
    body: { rect: centred(3, 3, 6.35, 9.8), heightMm: 4.5, side: 'top' }, mark: 'pin1'
  },
  'terminal-2p-508': {
    id: 'terminal-2p-508', name: 'Terminal block 2P 5.08',
    pins: [p('1', 0, 0), p('2', 2, 0)],
    body: { rect: { x: 2 * PITCH / 2 - 5.08, y: PITCH / 2 - 3.8, w: 10.16, h: 7.6 }, heightMm: 10, side: 'top' }
  },
  'header-1x5': {
    id: 'header-1x5', name: 'Header 1x5',
    pins: [p('1', 0, 0), p('2', 1, 0), p('3', 2, 0), p('4', 3, 0), p('5', 4, 0)],
    body: { rect: { x: -1.27, y: -1.25, w: 12.7, h: 2.5 }, heightMm: 8.5, side: 'top' }, mark: 'pin1'
  },
  'polyfuse-radial': {
    id: 'polyfuse-radial', name: 'Polyfuse (radial)',
    pins: [p('a', 0, 0), p('b', 2, 0)], twoLead: { minSpan: 2, maxSpan: 2 },
    body: { rect: centredOrigin(8.9, 3.0), heightMm: 13, side: 'top' }
  },
  axial: {
    id: 'axial', name: 'Axial (resistor, diode)',
    pins: [p('a', 0, 0), p('b', 3, 0)], twoLead: { minSpan: 3, maxSpan: 6 },
    body: { rect: centredOrigin(6.3, 2.5), heightMm: 2.5, side: 'top' }, mark: 'stripe-b'
  },
  'cap-disc': {
    id: 'cap-disc', name: 'Disc capacitor',
    pins: [p('a', 0, 0), p('b', 1, 0)], twoLead: { minSpan: 1, maxSpan: 2 },
    body: { rect: centredOrigin(5.0, 2.5), heightMm: 8, side: 'top' }
  }
}

/** Standing axial parts are 7 mm tall and cover a circle of this diameter over lead a. */
const STANDING_DIAMETER_MM = 2.7
const STANDING_HEIGHT_MM = 7

/** Rotate clockwise seen from the top by `rot` degrees: (dx,dy) -> (-dy,dx) per 90 degrees. */
export function rotateOffset(dx: number, dy: number, rot: number): { dx: number; dy: number } {
  let x = dx
  let y = dy
  for (let i = 0; i < (((rot % 360) + 360) % 360) / 90; i++) [x, y] = [-y, x] as [number, number]
  return { dx: x + 0, dy: y + 0 } // + 0 normalises -0
}

function boxOf(corners: { x: number; y: number }[]): Rect {
  const xs = corners.map(c => c.x)
  const ys = corners.map(c => c.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function bodyHeightMm(part: Part, fp: Footprint): number {
  return part.standing && fp.twoLead ? STANDING_HEIGHT_MM : fp.body.heightMm
}

export function placePart(part: Part): PlacedPart {
  const fp = FOOTPRINTS[part.footprint]
  if (!fp) throw new Error(`unknown footprint: ${part.footprint}`)
  const at = parseHole(part.at)
  const roleOf = (name: string, fpRole?: PinRole): PinRole => part.roles?.[name] ?? fpRole ?? 'passive'
  const mk = (name: string, hole: Hole, fpRole?: PinRole) => ({
    name, hole, net: part.pins[name] ?? null, role: roleOf(name, fpRole)
  })

  let pins: PlacedPart['pins']
  let local: Rect // mm, relative to the origin point `originMm`
  let originMm: { x: number; y: number }
  let angle = 0 // radians, for twoLead axis

  if (fp.twoLead) {
    const a = at
    const b = part.to !== undefined ? parseHole(part.to) : { col: a.col + fp.twoLead.minSpan, row: a.row }
    pins = [mk('a', a, fp.pins[0]!.role), mk('b', b, fp.pins[1]!.role)]
    const am = holeMm(a, PITCH)
    const bm = holeMm(b, PITCH)
    if (part.standing) {
      const d = STANDING_DIAMETER_MM
      local = { x: -d / 2, y: -d / 2, w: d, h: d }
      originMm = am
    } else {
      angle = Math.atan2(bm.y - am.y, bm.x - am.x)
      local = fp.body.rect
      originMm = { x: (am.x + bm.x) / 2, y: (am.y + bm.y) / 2 }
    }
  } else {
    const sx = part.flip ? -1 : 1
    pins = fp.pins.map((pin) => {
      const r = rotateOffset(pin.dx * sx, pin.dy, part.rotation)
      return mk(pin.name, { col: at.col + r.dx, row: at.row + r.dy }, pin.role)
    })
    const rc = fp.body.rect
    const corners = [[rc.x, rc.y], [rc.x + rc.w, rc.y], [rc.x + rc.w, rc.y + rc.h], [rc.x, rc.y + rc.h]]
      .map(([cx, cy]) => {
        const r = rotateOffset(cx! * sx, cy!, part.rotation)
        return { x: r.dx, y: r.dy }
      })
    local = boxOf(corners)
    originMm = holeMm(at, PITCH)
  }

  let bodyRectMm: Rect
  if (fp.twoLead && !part.standing) {
    const c = local
    const cs = [[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]].map(([x, y]) => ({
      x: originMm.x + x! * Math.cos(angle) - y! * Math.sin(angle),
      y: originMm.y + x! * Math.sin(angle) + y! * Math.cos(angle)
    }))
    bodyRectMm = boxOf(cs)
  } else {
    bodyRectMm = { x: originMm.x + local.x, y: originMm.y + local.y, w: local.w, h: local.h }
  }

  const own = new Set(pins.map(x => `${x.hole.col},${x.hole.row}`))
  const m = 0.3
  const x0 = bodyRectMm.x + m
  const x1 = bodyRectMm.x + bodyRectMm.w - m
  const y0 = bodyRectMm.y + m
  const y1 = bodyRectMm.y + bodyRectMm.h - m
  const bodyHoles: Hole[] = []
  const c0 = Math.max(1, Math.floor(x0 / PITCH) + 1)
  const c1 = Math.ceil(x1 / PITCH) + 1
  const r0 = Math.max(1, Math.floor(y0 / PITCH) + 1)
  const r1 = Math.ceil(y1 / PITCH) + 1
  for (let row = r0; row <= r1; row++)
    for (let col = c0; col <= c1; col++) {
      const { x, y } = holeMm({ col, row }, PITCH)
      if (x > x0 && x < x1 && y > y0 && y < y1 && !own.has(`${col},${row}`)) bodyHoles.push({ col, row })
    }

  return { part, fp, pins, bodyHoles, bodyRectMm }
}
