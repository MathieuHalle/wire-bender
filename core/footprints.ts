import { holeMm, parseHole, type Hole } from './holes'
import type { Part, PinRole } from './schema'

/** The hole grid footprint bodies are laid out on (placePart uses it), mm. */
export const FOOTPRINT_PITCH_MM = 2.54
const PITCH = FOOTPRINT_PITCH_MM
/** Round component legs, mm (the 3D scene draws them at this diameter). */
export const LEG_DIAMETER_MM = 0.6
/** The metal tab plate: the back face of the body on the `tab` side, this thick, mm. */
export const TAB_PLATE_MM = 1.3
/** Bare metal closer than its radius plus this to a tab plate touches it, mm. */
export const TAB_CLEARANCE_MM = 0.2

export interface Footprint {
  id: string
  name: string
  /** Offsets in holes from pin 1, rotation 0. */
  pins: { name: string, dx: number, dy: number, role?: PinRole }[]
  /** Holes between `at` and `to`; pins are 'a' (at) and 'b' (to). */
  twoLead?: { minSpan: number, maxSpan: number }
  /**
   * Rotation 0, mm, relative to pin 1 centre; x right, y down. For twoLead parts
   * the rect is centred on the origin (the lead midpoint) with w along the lead axis.
   */
  body: { rect: { x: number, y: number, w: number, h: number }, heightMm: number, round?: boolean, side: 'top' }
  /** The 3D builder that draws it (core/scene3d/parts.ts); a family shares one. */
  shape: FootprintShape
  /**
   * `flat-b`: an LED's flat rim on lead b (the cathode). `minus-b`: an electrolytic's minus
   * stripe on lead b.
   */
  mark?: 'pin1' | 'stripe-b' | 'flat' | 'tab' | 'flat-b' | 'minus-b'
  /** DIP family: rows 3 holes apart (0.3") or 6 (0.6"), and whether it sits in a socket. */
  dip?: { rows: 3 | 6, socket: boolean }
  /** Header and socket families: one row or two. */
  header?: { rows: 1 | 2 }
  /**
   * Which way the metal tab (or flat side) faces: a unit vector at rotation 0 in footprint
   * space (x right, y down). placePart flips and rotates it with the pins.
   */
  tab?: Dir
  /** The pin the metal tab is connected to (TO-220: the drain). */
  tabPin?: string
}

export type FootprintShape
  = | 'relay-g5v2' | 'to220' | 'dip' | 'terminal' | 'header' | 'socket' | 'polyfuse' | 'axial' | 'cap-disc'
    | 'led' | 'cap-elec' | 'to92' | 'button' | 'trimmer-3296w' | 'trimmer-3362p' | 'relay-srd'

/** An axis-aligned unit vector, x right, y down. */
export interface Dir { dx: number, dy: number }

export interface Rect { x: number, y: number, w: number, h: number }

export interface PlacedPart {
  part: Part
  fp: Footprint
  pins: { name: string, hole: Hole, net: string | null, role: PinRole }[]
  /** Holes under the body, excluding the part's own pins. */
  bodyHoles: Hole[]
  /** Board mm, after rotation/flip. */
  bodyRectMm: Rect
  /** The footprint's tab direction after flip and rotation, when it has one. */
  tab?: Dir
}

const p = (name: string, dx: number, dy: number) => ({ name, dx, dy })
/** Rect of size w x h centred on a pin box that spans bx x by holes. */
const centred = (bx: number, by: number, w: number, h: number): Rect => ({
  x: (bx * PITCH) / 2 - w / 2, y: (by * PITCH) / 2 - h / 2, w, h
})
const centredOrigin = (w: number, h: number): Rect => ({ x: -w / 2, y: -h / 2, w, h })

const range = (from: number, to: number, step = 1): number[] =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step)

/** Header and socket families' height above the board, mm. */
export const HEADER_HEIGHT_MM = 8.5
/** A DIP chip's height; in a turned-pin socket it stands this much higher. */
export const DIP_HEIGHT_MM = 4.5
export const DIP_SOCKET_LIFT_MM = 3
/** A DIP socket's frame reaches this far past the chip on each pin side, mm. */
export const DIP_SOCKET_RIM_MM = 1.27
export const HEADER_MAX = 40
export const DIP_PINS = { min: 4, max: 40, wideMin: 24 }
export const TERMINAL_POLES = { min: 2, max: 6 }

/**
 * A header (male, shape `header`) or a socket (female header, shape `socket`), `rows` x `n`.
 * One row: pins 1..n left to right. Two rows: odd pins on row 0 and even pins on row 1, pin 2
 * under pin 1 (the usual IDC numbering).
 */
function headerFp(kind: 'header' | 'socket', rows: 1 | 2, n: number): Footprint {
  const pins = rows === 1
    ? range(0, n - 1).map(i => p(String(i + 1), i, 0))
    : range(0, n - 1).flatMap(i => [p(String(2 * i + 1), i, 0), p(String(2 * i + 2), i, 1)])
  return {
    id: `${kind}-${rows}x${n}`,
    name: kind === 'header' ? `Header ${rows}x${n}` : `Socket ${rows}x${n} (female header)`,
    pins,
    body: { rect: { x: -PITCH / 2, y: -1.25, w: n * PITCH, h: rows * PITCH - 0.04 }, heightMm: HEADER_HEIGHT_MM, side: 'top' },
    shape: kind, mark: 'pin1', header: { rows }
  }
}

/**
 * A DIP chip of `n` pins: 1..n/2 down the left column, then back up the right one, the
 * columns 3 holes (0.3") or, `wide`, 6 holes (0.6") apart. In a `socket`, 3 mm higher.
 */
function dipFp(n: number, wide: boolean, socket: boolean): Footprint {
  const rows = wide ? 6 : 3
  const half = n / 2
  const pins = [
    ...range(0, half - 1).map(i => p(String(i + 1), 0, i)),
    ...range(0, half - 1).map(i => p(String(half + i + 1), rows, half - 1 - i))
  ]
  const id = `dip${n}${wide ? '-wide' : ''}${socket ? '-socket' : ''}`
  return {
    id, name: `DIP-${n}${wide ? ' (0.6")' : ''}${socket ? ' in a socket' : ''}`,
    pins,
    // A socket's frame reaches past the pins, DIP_SOCKET_RIM_MM wider than the chip each side.
    body: { rect: centred(rows, half - 1, rows * PITCH - 1.27 + (socket ? 2 * DIP_SOCKET_RIM_MM : 0), half * PITCH - 0.36), heightMm: DIP_HEIGHT_MM + (socket ? DIP_SOCKET_LIFT_MM : 0), side: 'top' },
    shape: 'dip', mark: 'pin1', dip: { rows, socket }
  }
}

/** A screw terminal block of `n` poles at 5.08 mm (2 holes). */
function terminalFp(n: number): Footprint {
  const w = n * 5.08
  return {
    id: `terminal-${n}p-508`, name: `Terminal block ${n}P 5.08`,
    pins: range(0, n - 1).map(i => p(String(i + 1), 2 * i, 0)),
    body: { rect: { x: (n - 1) * PITCH - w / 2, y: PITCH / 2 - 3.8, w, h: 7.6 }, heightMm: 10, side: 'top' },
    shape: 'terminal'
  }
}

const SINGLES: Footprint[] = [
  {
    id: 'relay-g5v2', name: 'Relay G5V-2',
    pins: [p('1', 0, 0), p('16', 3, 0), p('4', 0, 3), p('13', 3, 3), p('6', 0, 5), p('11', 3, 5), p('8', 0, 7), p('9', 3, 7)],
    body: { rect: centred(3, 7, 10.1, 20.5), heightMm: 11.5, side: 'top' }, shape: 'relay-g5v2', mark: 'pin1'
  },
  {
    id: 'to220-gds', name: 'TO-220 (G D S)',
    pins: [p('G', 0, 0), p('D', 0, 1), p('S', 0, 2)],
    // Straight-mounted: 4.5 thick over the pin line, the pins 2.5 from the tab (back) face.
    body: { rect: { x: 2.5 - 4.5, y: PITCH - 5, w: 4.5, h: 10.0 }, heightMm: 15.5, side: 'top' },
    shape: 'to220', mark: 'tab', tab: { dx: 1, dy: 0 }, tabPin: 'D'
  },
  {
    id: 'polyfuse-radial', name: 'Polyfuse (radial)',
    pins: [p('a', 0, 0), p('b', 2, 0)], twoLead: { minSpan: 2, maxSpan: 2 },
    body: { rect: centredOrigin(7.0, 3.0), heightMm: 13, side: 'top' }, shape: 'polyfuse'
  },
  {
    id: 'axial', name: 'Axial (resistor, diode)',
    pins: [p('a', 0, 0), p('b', 3, 0)], twoLead: { minSpan: 3, maxSpan: 6 },
    body: { rect: centredOrigin(6.3, 2.5), heightMm: 2.5, side: 'top' }, shape: 'axial', mark: 'stripe-b'
  },
  {
    id: 'cap-disc', name: 'Disc capacitor',
    pins: [p('a', 0, 0), p('b', 1, 0)], twoLead: { minSpan: 1, maxSpan: 2 },
    body: { rect: centredOrigin(5.0, 2.5), heightMm: 8, side: 'top' }, shape: 'cap-disc'
  }
]

/** A round LED: `flange` is the rim's diameter, mm. 1 mm off the board on its legs. */
function ledFp(size: 3 | 5, flange: number, heightMm: number): Footprint {
  return {
    id: `led-${size}mm`, name: `LED ${size} mm`,
    pins: [p('a', 0, 0), p('b', 1, 0)], twoLead: { minSpan: 1, maxSpan: 1 },
    body: { rect: centredOrigin(flange, flange), heightMm, round: true, side: 'top' }, shape: 'led', mark: 'flat-b'
  }
}

/** Radial electrolytic can sizes, diameter x height mm, and their lead span in holes. */
export const CAP_ELEC_SIZES: { d: number, h: number, span: number }[] = [
  { d: 5, h: 11, span: 1 }, { d: 6.3, h: 11, span: 1 }, { d: 8, h: 12, span: 2 }, { d: 10, h: 16, span: 2 }, { d: 10, h: 20, span: 2 }
]
/** The rubber seal an electrolytic stands on, mm. */
export const CAP_ELEC_BASE_MM = 0.5

function capElecFp({ d, h, span }: { d: number, h: number, span: number }): Footprint {
  return {
    id: `cap-elec-${d}x${h}`, name: `Electrolytic capacitor ${d} x ${h} mm`,
    pins: [p('a', 0, 0), p('b', span, 0)], twoLead: { minSpan: span, maxSpan: span },
    body: { rect: centredOrigin(d, d), heightMm: h + CAP_ELEC_BASE_MM, round: true, side: 'top' }, shape: 'cap-elec', mark: 'minus-b'
  }
}

/** TO-92: a D-shaped body 4.8 wide and 3.8 deep (flat face toward +y at rotation 0), on 3 mm of leg. */
export const TO92_LIFT_MM = 3
const TO92: Footprint = {
  id: 'to92', name: 'TO-92',
  pins: [p('1', 0, 0), p('2', 1, 0), p('3', 2, 0)],
  body: { rect: { x: PITCH - 2.4, y: -2.3, w: 4.8, h: 3.8 }, heightMm: TO92_LIFT_MM + 4.5, side: 'top' },
  shape: 'to92', mark: 'flat', tab: { dx: 0, dy: 1 }
}

/** 6 x 6 mm tact switch heights, mm. */
export const BUTTON_HEIGHTS = [4.3, 5, 7, 9.5, 13]
/** A 6 x 6 tact switch: `1`-`2` and `3`-`4` are joined inside; pressing joins the pairs. */
function buttonFp(heightMm: number): Footprint {
  return {
    id: `button-6x6-h${heightMm}`, name: `Tact switch 6 x 6, ${heightMm} mm`,
    pins: [p('1', 0, 0), p('2', 3, 0), p('3', 0, 2), p('4', 3, 2)],
    body: { rect: centred(3, 2, 6, 6), heightMm, side: 'top' }, shape: 'button'
  }
}

/** Trimmers: pins `1`, `2` (the wiper) and `3` in a row, the body centred over pin 2. */
const TRIMMERS: Footprint[] = [
  {
    id: 'trimmer-3296w', name: 'Trimmer 3296W (multi-turn, top adjust)',
    pins: [p('1', 0, 0), p('2', 1, 0), p('3', 2, 0)],
    body: { rect: { x: PITCH - 4.75, y: -2.4, w: 9.5, h: 4.8 }, heightMm: 10, side: 'top' }, shape: 'trimmer-3296w', mark: 'pin1'
  },
  {
    id: 'trimmer-3362p', name: 'Trimmer 3362P (single turn)',
    pins: [p('1', 0, 0), p('2', 1, 0), p('3', 2, 0)],
    body: { rect: { x: PITCH - 3.4, y: -3.5, w: 6.8, h: 7.0 }, heightMm: 4.5, side: 'top' }, shape: 'trimmer-3362p', mark: 'pin1'
  }
]

/**
 * Songle / Sanyou SRD (SRD-05VDC-SL-C and kin), pins numbered as KiCad's
 * Relay_SPDT_SANYOU_SRD_Series_Form_C: `1` COM, `2` and `5` the coil, `3` and `4` the two
 * contacts (which is NO and which NC is not given there: check it with a meter, or on the
 * diagram printed on the relay). Its pads are off the 2.54 grid; snapped to the nearest holes,
 * each is 1 to 1.5 mm out, so the legs are bent to fit. KiCad pad (mm from pad 1, y down) ->
 * hole offset: 1 (0, 0) -> (0, 0); 2 (1.95, 6.05) -> (1, 2); 3 (14.15, 6.05) -> (6, 2);
 * 4 (14.2, -6) -> (6, -2); 5 (1.95, -5.95) -> (1, -2).
 */
export const RELAY_SRD_PADS_MM: Record<string, { x: number, y: number }> = {
  1: { x: 0, y: 0 }, 2: { x: 1.95, y: 6.05 }, 3: { x: 14.15, y: 6.05 }, 4: { x: 14.2, y: -6 }, 5: { x: 1.95, y: -5.95 }
}
const RELAY_SRD: Footprint = {
  id: 'relay-srd', name: 'Relay SRD (Songle, bend to fit)',
  pins: [p('1', 0, 0), p('2', 1, 2), p('3', 6, 2), p('4', 6, -2), p('5', 1, -2)],
  // 19 x 15.5 x 15, placed as KiCad's fab outline (its long side from 1.0 mm behind pad 1).
  body: { rect: { x: -1.0, y: -7.75, w: 19, h: 15.5 }, heightMm: 15, side: 'top' }, shape: 'relay-srd', mark: 'pin1'
}

const FAMILIES: Footprint[] = [
  RELAY_SRD,
  TO92,
  ...BUTTON_HEIGHTS.map(buttonFp),
  ...TRIMMERS,
  ledFp(3, 3.8, 6.5),
  ledFp(5, 5.8, 9.6),
  ...CAP_ELEC_SIZES.map(capElecFp),
  ...([1, 2] as const).flatMap(rows => (['header', 'socket'] as const).flatMap(kind => range(1, HEADER_MAX).map(n => headerFp(kind, rows, n)))),
  ...range(DIP_PINS.min, DIP_PINS.max, 2).flatMap(n => [dipFp(n, false, false), dipFp(n, false, true)]),
  ...range(DIP_PINS.wideMin, DIP_PINS.max, 2).flatMap(n => [dipFp(n, true, false), dipFp(n, true, true)]),
  ...range(TERMINAL_POLES.min, TERMINAL_POLES.max).map(terminalFp)
]

export const FOOTPRINTS: Record<string, Footprint> = Object.fromEntries([...SINGLES, ...FAMILIES].map(fp => [fp.id, fp]))

/**
 * Standing axial parts are 7 mm tall and cover a circle over lead a: 2.7 mm for a diode
 * (1N4001), 2.5 mm for a 1/4 W resistor, so two standing resistors fit on neighbouring holes.
 */
const STANDING_DIODE_DIAMETER_MM = 2.7
const STANDING_RESISTOR_DIAMETER_MM = 2.5
const STANDING_HEIGHT_MM = 7

/** A diode, from its value or label ("1N4001", "D1N4148", "diode"). */
export function isDiodePart(part: Part): boolean {
  return /diode|1N\d{4}/i.test(`${part.value ?? ''} ${part.label ?? ''}`)
}

/** Rotate clockwise seen from the top by `rot` degrees: (dx,dy) -> (-dy,dx) per 90 degrees. */
export function rotateOffset(dx: number, dy: number, rot: number): { dx: number, dy: number } {
  let x = dx
  let y = dy
  for (let i = 0; i < (((rot % 360) + 360) % 360) / 90; i++) [x, y] = [-y, x] as [number, number]
  return { dx: x + 0, dy: y + 0 } // + 0 normalises -0
}

function boxOf(corners: { x: number, y: number }[]): Rect {
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
  let originMm: { x: number, y: number }
  let angle = 0 // radians, for twoLead axis
  let tab: Dir | undefined

  if (fp.twoLead) {
    const a = at
    const b = part.to !== undefined ? parseHole(part.to) : { col: a.col + fp.twoLead.minSpan, row: a.row }
    pins = [mk('a', a, fp.pins[0]!.role), mk('b', b, fp.pins[1]!.role)]
    const am = holeMm(a, PITCH)
    const bm = holeMm(b, PITCH)
    if (part.standing) {
      const d = isDiodePart(part) ? STANDING_DIODE_DIAMETER_MM : STANDING_RESISTOR_DIAMETER_MM
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
    if (fp.tab) tab = rotateOffset(fp.tab.dx * sx, fp.tab.dy, part.rotation)
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

  return { part, fp, pins, bodyHoles, bodyRectMm, ...(tab ? { tab } : {}) }
}

/**
 * The metal tab plate in board mm: the back TAB_PLATE_MM of the body rect on the tab side,
 * or undefined for a footprint without a tab.
 */
export function tabPlateMm(pp: PlacedPart): Rect | undefined {
  const n = pp.tab
  if (!n || pp.fp.mark !== 'tab') return undefined
  const r = pp.bodyRectMm
  const t = TAB_PLATE_MM
  if (n.dx > 0) return { ...r, x: r.x + r.w - t, w: t }
  if (n.dx < 0) return { ...r, w: t }
  if (n.dy > 0) return { ...r, y: r.y + r.h - t, h: t }
  return { ...r, h: t }
}
