import { bodyHeightMm, isDiodePart, DIP_SOCKET_LIFT_MM, DIP_SOCKET_RIM_MM, FOOTPRINT_PITCH_MM, TAB_PLATE_MM, tabPlateMm, type PlacedPart, type Rect } from '../footprints'
import { holeMm } from '../holes'
import {
  BOARD_BOTTOM_Y, COLORS, LEG_DIAMETER_MM, LEG_END_Y, LEG_FOLD_Y, SOLDER_BASE_DIAMETER_MM, SOLDER_HEIGHT_MM
} from './dims'
import type { Prim, Tag, V3 } from './types'

const LEG_R = LEG_DIAMETER_MM / 2
/** DIP packages stand on their lead shoulders. */
const DIP_LIFT_MM = 0.5
/** Height of the flat DIP lead shoulders, and the flat lead section (width x thickness). */
const DIP_SHOULDER_Y = DIP_LIFT_MM + 1
const DIP_LEAD_W_MM = 0.5
const DIP_LEAD_T_MM = 0.25
const DIP_NOTCH_W_MM = 1.6
const DIP_NOTCH_D_MM = 0.8
/** Moulded or printed marks stand this far proud of the surface they sit on. */
const MARK_MM = 0.02
/** Pin-1 dots sit this far in from both edges at the body corner nearest pin 1. */
const PIN1_DOT_IN_MM = 1.2
const HEADER_BAR_MM = 2.5
const HEADER_CHAMFER_MM = 0.3
const HEADER_POST_MM = 0.64
const TO220_TAB_ABOVE_MM = 6
const TO220_HOLE_MM = 3.6
const SCREW_R_MM = 1.5
/** Terminal screw heads stand this far proud of the body top; their slots a mark above that. */
const SCREW_PROUD_MM = MARK_MM
/** Radial parts (polyfuse) stand on kinked leads. */
const RADIAL_LIFT_MM = 2
const STANDING_ARC_STEPS = 8
/** Where a standing lead b kinks out to a hole more than a pitch away. */
const STANDING_KINK_Y = 1
const STRIPE_MM = 0.8
/** The diode band stands this far proud of the body (under the 0.05 height tolerance on top). */
const STRIPE_PROUD_MM = 0.04
/** The square entry on top of a female header's pin. */
const SOCKET_ENTRY_MM = 1.0

type Pin = PlacedPart['pins'][number]
interface XZ { x: number, z: number }

const pinXZ = (pin: Pin): XZ => {
  const m = holeMm(pin.hole, FOOTPRINT_PITCH_MM)
  return { x: m.x, z: m.y }
}

/** A box over a board-mm rect from y0 to y1. */
function rectBox(r: Rect, y0: number, y1: number, color: string, tag: Tag): Prim {
  return { kind: 'box', center: [r.x + r.w / 2, (y0 + y1) / 2, r.y + r.h / 2], size: [r.w, y1 - y0, r.h], color, tag }
}

/** Four boxes filling `outer` round the hole `inner` (inside it), from y0 to y1. */
function frameBoxes(outer: Rect, inner: Rect, y0: number, y1: number, color: string, tag: Tag): Prim[] {
  const right = outer.x + outer.w
  const bottom = outer.y + outer.h
  return [
    { x: outer.x, y: outer.y, w: outer.w, h: inner.y - outer.y },
    { x: outer.x, y: inner.y + inner.h, w: outer.w, h: bottom - inner.y - inner.h },
    { x: outer.x, y: inner.y, w: inner.x - outer.x, h: inner.h },
    { x: inner.x + inner.w, y: inner.y, w: right - inner.x - inner.w, h: inner.h }
  ].filter(q => q.w > 0 && q.h > 0).map(q => rectBox(q, y0, y1, color, tag))
}

/**
 * A box of length `len` along the horizontal unit axis u, thickness `t` across it, centred at c.
 * rotY uses the three.js convention: local +x maps to (cos, 0, -sin).
 */
function axisBox(c: XZ, u: XZ, len: number, t: number, y0: number, y1: number, color: string, tag: Tag): Prim {
  const center: V3 = [c.x, (y0 + y1) / 2, c.z]
  if (Math.abs(u.z) < 1e-9) return { kind: 'box', center, size: [len, y1 - y0, t], color, tag }
  if (Math.abs(u.x) < 1e-9) return { kind: 'box', center, size: [t, y1 - y0, len], color, tag }
  return { kind: 'box', center, size: [len, y1 - y0, t], rotY: Math.atan2(-u.z, u.x), color, tag }
}

/** Unit vector a -> b and the lead midpoint. */
function leadAxis(a: XZ, b: XZ): { u: XZ, mid: XZ } {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len = Math.hypot(dx, dz) || 1
  return { u: { x: dx / len, z: dz / len }, mid: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } }
}

const isDiode = (pp: PlacedPart): boolean => isDiodePart(pp.part)

const centreOf = (r: Rect): XZ => ({ x: r.x + r.w / 2, z: r.y + r.h / 2 })

/** The axis-aligned unit normal from the pins' centroid toward the body rect's centre. */
function awayFromPins(r: Rect, pins: Pin[]): XZ {
  const pc = pins.map(pinXZ)
  const c = centreOf(r)
  const dx = c.x - pc.reduce((s, q) => s + q.x, 0) / pc.length
  const dz = c.z - pc.reduce((s, q) => s + q.z, 0) / pc.length
  return Math.abs(dx) > Math.abs(dz) ? { x: dx >= 0 ? 1 : -1, z: 0 } : { x: 0, z: dz >= 0 ? 1 : -1 }
}

/** Half the rect's extent along an axis-aligned unit vector. */
const halfAlong = (r: Rect, n: XZ): number => (Math.abs(n.x) * r.w + Math.abs(n.z) * r.h) / 2

/** A flat disc on a horizontal surface at y, MARK_MM thick. */
const disc = (c: XZ, y: number, radius: number, color: string, tag: Tag): Prim =>
  ({ kind: 'cylinder', a: [c.x, y, c.z], b: [c.x, y + MARK_MM, c.z], radius, color, tag })

/** The point `inset` mm in from both edges at the rect corner nearest `q`. */
function cornerNear(r: Rect, q: XZ, inset: number): XZ {
  const c = centreOf(r)
  return {
    x: q.x < c.x ? r.x + inset : r.x + r.w - inset,
    z: q.z < c.z ? r.y + inset : r.y + r.h - inset
  }
}

/**
 * Lead b of a standing axial: out of the top cap, a hairpin arc over the top, then down beside
 * the body. The down run is at most a pitch from the body axis; a farther hole gets a kink out
 * to it just above the board.
 */
function standingLeadB(a: XZ, b: XZ, h: number, endY: number): V3[] {
  const s = Math.hypot(b.x - a.x, b.z - a.z)
  const { u } = leadAxis(a, b)
  const d = Math.min(s, FOOTPRINT_PITCH_MM)
  const at = (t: number, y: number): V3 => [a.x + u.x * t, y, a.z + u.z * t]
  const pts: V3[] = []
  for (let i = 0; i <= STANDING_ARC_STEPS; i++) {
    const th = Math.PI * (1 - i / STANDING_ARC_STEPS)
    pts.push(at(d / 2 + (d / 2) * Math.cos(th), h + (d / 2) * Math.sin(th)))
  }
  pts[pts.length - 1] = at(d, h) // exact, so the down run is vertical
  if (d < s) pts.push(at(d, STANDING_KINK_Y), [b.x, STANDING_KINK_Y, b.z])
  pts.push([b.x, endY, b.z])
  return pts
}

/**
 * Body prims, legs and the solder joint under each leg for one placed part. `groupNets`
 * gives a lead's connectivity-group nets (`ref.pin`) for the leg and joint tags. Leads in
 * `folded` (`ref.pin`, from legFolds) end on the bottom surface, where their fold tube lies,
 * instead of in a cut stub below the board.
 */
export function partPrims(
  pp: PlacedPart, groupNets?: (lead: string) => string[] | undefined, folded: ReadonlySet<string> = new Set()
): Prim[] {
  const { part, fp, pins, bodyRectMm: r } = pp
  // Every body's highest point is this height (the bench sheet's height column), within the
  // 0.02 marks and screw heads on top.
  const h = bodyHeightMm(part, fp)
  const body: Tag = { kind: 'part', id: part.ref, label: part.label ?? part.ref }
  const netsOf = (pin: Pin) => {
    const nets = groupNets?.(`${part.ref}.${pin.name}`)
    return nets ? { nets } : {}
  }
  const legTag = (pin: Pin): Tag => ({ kind: 'leg', id: `${part.ref}.${pin.name}`, net: pin.net, ...netsOf(pin), label: `${part.ref} pin ${pin.name}` })
  /** Where a leg ends under the board: cut below it, or on the surface when folded. */
  const legEnd = (pin: Pin) => (folded.has(`${part.ref}.${pin.name}`) ? LEG_FOLD_Y : LEG_END_Y)
  const out: Prim[] = []
  /** Pin name -> leg top y for straight legs; tubes go in `out` directly. */
  const straight = new Map<string, number>()

  const two = fp.twoLead ? { a: pinXZ(pins[0]!), b: pinXZ(pins[1]!) } : null
  const axis = two ? leadAxis(two.a, two.b) : null
  const allStraight = (top: number) => pins.forEach(p => straight.set(p.name, top))
  const pinNamed = (name: string) => pinXZ(pins.find(p => p.name === name) ?? pins[0]!)
  const c = centreOf(r)

  switch (fp.shape) {
    case 'relay-g5v2':
      out.push(rectBox(r, 0, h, COLORS.relay, body))
      out.push(disc(cornerNear(r, pinNamed('1'), PIN1_DOT_IN_MM), h, 0.6, COLORS.markLight, body))
      allStraight(0)
      break
    case 'to220': {
      // Straight-mounted on its legs (the owner's choice): the body stands over the pins and
      // the tab plate (core's tabPlateMm) is its back face on the tab side, reaching the full
      // height. The footprint always has a tab, so the plate is defined.
      const n: XZ = { x: pp.tab!.dx, z: pp.tab!.dy }
      const tab = tabPlateMm(pp)!
      const y0 = 0
      const top = h
      // The plastic is the rest of the rect, in front of the plate.
      const front: Rect = n.x !== 0
        ? { ...r, x: n.x > 0 ? r.x : r.x + tab.w, w: r.w - tab.w }
        : { ...r, y: n.z > 0 ? r.y : r.y + tab.h, h: r.h - tab.h }
      out.push(rectBox(front, y0, top - TO220_TAB_ABOVE_MM, COLORS.black, body))
      out.push({ ...rectBox(tab, y0, top, COLORS.tab, body), metal: true })
      // The mounting hole: a dark disc through the plate, centred on the part above the body.
      const hc = centreOf(tab)
      const hy = top - TO220_TAB_ABOVE_MM / 2
      const e = TAB_PLATE_MM / 2 + MARK_MM
      out.push({
        kind: 'cylinder', radius: TO220_HOLE_MM / 2, color: COLORS.tabHole, tag: body,
        a: [hc.x - n.x * e, hy, hc.z - n.z * e], b: [hc.x + n.x * e, hy, hc.z + n.z * e]
      })
      allStraight(y0)
      break
    }
    case 'dip': {
      // In a socket the chip stands on the socket's top; the socket's body rect covers the pins.
      const base = fp.dip?.socket ? DIP_SOCKET_LIFT_MM : 0
      const p1 = pinNamed('1')
      const pn = pinNamed(String(pins.length))
      // Pin 1 and pin N face each other across the rows.
      const acrossX = Math.abs(pn.x - p1.x) > Math.abs(pn.z - p1.z)
      const chip: Rect = !fp.dip?.socket
        ? r
        : acrossX
          ? { ...r, x: r.x + DIP_SOCKET_RIM_MM, w: r.w - 2 * DIP_SOCKET_RIM_MM }
          : { ...r, y: r.y + DIP_SOCKET_RIM_MM, h: r.h - 2 * DIP_SOCKET_RIM_MM }
      if (fp.dip?.socket) {
        // A turned-pin socket: a frame round an open middle, a gold ring at every pin.
        const open = acrossX
          ? { x: chip.x + 1.6, y: r.y + 1, w: chip.w - 3.2, h: r.h - 2 }
          : { x: r.x + 1, y: chip.y + 1.6, w: r.w - 2, h: chip.h - 3.2 }
        out.push(rectBox(r, 0, base - 0.6, COLORS.socket, body))
        out.push(...frameBoxes(r, open, base - 0.6, base, COLORS.socket, body))
        for (const pin of pins) {
          const q = pinXZ(pin)
          out.push({ kind: 'cylinder', a: [q.x, base - 0.6, q.z], b: [q.x, base + MARK_MM, q.z], radius: 0.75, color: COLORS.headerPin, metal: true, tag: body })
        }
      }
      // On its 0.5 lead shoulders; the box is 0.5 shorter so the top is at the footprint height.
      const y0 = base + DIP_LIFT_MM
      const y1 = h
      const cc = centreOf(chip)
      out.push(rectBox(chip, y0, y1, COLORS.black, body))
      // The notch on the pin-1 end (the end with pins 1 and N) and the pin-1 dot.
      const end = leadAxis(cc, { x: (p1.x + pn.x) / 2, z: (p1.z + pn.z) / 2 }).u
      const v = Math.abs(end.x) > Math.abs(end.z) ? { x: Math.sign(end.x), z: 0 } : { x: 0, z: Math.sign(end.z) }
      const nd = halfAlong(chip, v) - DIP_NOTCH_D_MM / 2
      out.push(axisBox({ x: cc.x + v.x * nd, z: cc.z + v.z * nd }, { x: -v.z, z: v.x }, DIP_NOTCH_W_MM, DIP_NOTCH_D_MM, y1, y1 + MARK_MM, COLORS.markDark, body))
      out.push(disc(cornerNear(chip, p1, PIN1_DOT_IN_MM), y1, 0.45, COLORS.markDark, body))
      // Flat leads: out of the body side at shoulder height, then down into the hole (or the socket).
      for (const pin of pins) {
        const q = pinXZ(pin)
        const n = Math.abs(q.x - cc.x) > chip.w / 2
          ? { x: Math.sign(q.x - cc.x), z: 0 }
          : { x: 0, z: Math.sign(q.z - cc.z) }
        const inner = halfAlong(chip, n) - 0.3 // starts inside the body
        const outer = Math.abs(n.x) * Math.abs(q.x - cc.x) + Math.abs(n.z) * Math.abs(q.z - cc.z) + DIP_LEAD_T_MM / 2
        const mid = (inner + outer) / 2
        const across = n.x !== 0 ? { x: cc.x + n.x * mid, z: q.z } : { x: q.x, z: cc.z + n.z * mid }
        const tag = legTag(pin)
        const sh = base + DIP_SHOULDER_Y
        out.push({ ...axisBox(across, n, outer - inner, DIP_LEAD_W_MM, sh - DIP_LEAD_T_MM / 2, sh + DIP_LEAD_T_MM / 2, COLORS.leg, tag), metal: true })
        out.push({ ...axisBox(q, n, DIP_LEAD_T_MM, DIP_LEAD_W_MM, base, sh + DIP_LEAD_T_MM / 2, COLORS.leg, tag), metal: true })
      }
      allStraight(0)
      break
    }
    case 'terminal': {
      out.push(rectBox(r, 0, h, COLORS.terminal, body))
      // The wire side is the long face the pins are nearer.
      const w = awayFromPins(r, pins)
      w.x = -w.x
      w.z = -w.z
      const along = { x: -w.z, z: w.x }
      const face = halfAlong(r, w) - 0.14 // 0.3 deep, 0.02 proud of the face
      for (const pin of pins) {
        const q = pinXZ(pin)
        // The screw head is flush with the top (it sits in its well) and its slot a mark above.
        out.push({ kind: 'cylinder', a: [q.x, h - 0.4, q.z], b: [q.x, h + SCREW_PROUD_MM, q.z], radius: SCREW_R_MM, color: COLORS.screw, metal: true, tag: body })
        out.push(axisBox(q, along, 2.4, 0.5, h - 0.1, h + SCREW_PROUD_MM + MARK_MM, COLORS.slot, body))
        const e = w.x !== 0 ? { x: c.x + w.x * face, z: q.z } : { x: q.x, z: c.z + w.z * face }
        out.push(axisBox(e, along, 3.2, 0.32, 1.2, 4.6, COLORS.wireEntry, body))
      }
      allStraight(0)
      break
    }
    case 'socket': {
      // A female header: a tall black body with its top edges chamfered and a square entry
      // over every pin; the pin's tail under it is the leg.
      const k = HEADER_CHAMFER_MM
      out.push(rectBox(r, 0, h - k, COLORS.black, body))
      out.push(rectBox({ x: r.x + k, y: r.y + k, w: r.w - 2 * k, h: r.h - 2 * k }, h - k, h, COLORS.black, body))
      for (const pin of pins) {
        const q = pinXZ(pin)
        out.push({ kind: 'box', center: [q.x, h + MARK_MM / 2, q.z], size: [SOCKET_ENTRY_MM, MARK_MM, SOCKET_ENTRY_MM], color: COLORS.slot, tag: body })
        out.push({ kind: 'cylinder', a: [q.x, 0, q.z], b: [q.x, legEnd(pin), q.z], radius: HEADER_POST_MM / 2, color: COLORS.headerPin, metal: true, tag: legTag(pin) })
      }
      const p1 = pinNamed('1')
      const next = pins.find(p => p.name === (fp.header?.rows === 2 ? '3' : '2'))
      if (next) {
        const u = leadAxis(pinXZ(next), p1).u
        const d = SOCKET_ENTRY_MM / 2 + 0.35
        out.push(axisBox({ x: p1.x + u.x * d, z: p1.z + u.z * d }, u, 0.25, 0.9, h, h + MARK_MM, COLORS.markLight, body))
      }
      break
    }
    case 'header': {
      // A bar with its top edges chamfered: the full bar, then a narrower cap.
      const k = HEADER_CHAMFER_MM
      out.push(rectBox(r, 0, HEADER_BAR_MM - k, COLORS.black, body))
      out.push(rectBox({ x: r.x + k, y: r.y + k, w: r.w - 2 * k, h: r.h - 2 * k }, HEADER_BAR_MM - k, HEADER_BAR_MM, COLORS.black, body))
      for (const pin of pins) {
        const q = pinXZ(pin)
        out.push({
          kind: 'box', center: [q.x, (HEADER_BAR_MM + h) / 2, q.z], size: [HEADER_POST_MM, h - HEADER_BAR_MM, HEADER_POST_MM],
          color: COLORS.headerPin, metal: true, tag: body
        })
        // The post's tail under the bar is the leg, in gold.
        out.push({ kind: 'cylinder', a: [q.x, 0, q.z], b: [q.x, legEnd(pin), q.z], radius: HEADER_POST_MM / 2, color: COLORS.headerPin, metal: true, tag: legTag(pin) })
      }
      // A stepped triangle on the bar, outboard of pin 1 along its row, pointing at it (none
      // on a header of one column).
      const p1 = pinNamed('1')
      const next = pins.find(p => p.name === (fp.header?.rows === 2 ? '3' : '2'))
      if (next) {
        const u = leadAxis(pinXZ(next), p1).u
        const steps = [0.4, 0.9, 1.4]
        steps.forEach((wd, i) => {
          const d = HEADER_POST_MM / 2 + 0.15 + i * 0.2
          out.push(axisBox({ x: p1.x + u.x * d, z: p1.z + u.z * d }, u, 0.2, wd, HEADER_BAR_MM, HEADER_BAR_MM + MARK_MM, COLORS.markLight, body))
        })
      }
      break
    }
    case 'polyfuse':
      // Standing radial: a thin plate across the two leads.
      out.push(axisBox(axis!.mid, axis!.u, fp.body.rect.w, fp.body.rect.h, RADIAL_LIFT_MM, h, COLORS.polyfuse, body))
      allStraight(RADIAL_LIFT_MM)
      break
    case 'cap-disc': {
      // A disc standing on edge, its face containing the lead axis.
      const R = fp.body.rect.w / 2
      const t = fp.body.rect.h
      const cy = h - R
      const n = { x: -axis!.u.z, z: axis!.u.x }
      const m = axis!.mid
      out.push({
        kind: 'cylinder', radius: R, color: COLORS.capDisc, tag: body,
        a: [m.x - n.x * t / 2, cy, m.z - n.z * t / 2], b: [m.x + n.x * t / 2, cy, m.z + n.z * t / 2]
      })
      for (const pin of pins) {
        const c = pinXZ(pin)
        const d = Math.hypot(c.x - m.x, c.z - m.z)
        straight.set(pin.name, d < R ? cy - Math.sqrt(R * R - d * d) : cy)
      }
      break
    }
    case 'axial': {
      const diode = isDiode(pp)
      const R = fp.body.rect.h / 2
      const color = diode ? COLORS.diode : COLORS.resistor
      const { a, b } = two!
      if (part.standing) {
        // Vertical over lead a, as wide as the 2D body circle; lead b runs up beside it and over the top.
        const Rs = pp.bodyRectMm.w / 2
        out.push({ kind: 'cylinder', a: [a.x, 0, a.z], b: [a.x, h, a.z], radius: Rs, color, tag: body })
        if (diode)
          out.push({ kind: 'cylinder', a: [a.x, h - STRIPE_MM - 0.4, a.z], b: [a.x, h - 0.4, a.z], radius: Rs + STRIPE_PROUD_MM, color: COLORS.diodeStripe, tag: body })
        straight.set('a', 0)
        out.push({ kind: 'tube', radius: LEG_R, color: COLORS.leg, metal: true, tag: legTag(pins[1]!), points: standingLeadB(a, b, h, legEnd(pins[1]!)) })
      } else {
        // Lying on the board along the lead axis; leads bend down at the holes.
        const { u, mid } = axis!
        const L = fp.body.rect.w
        const ea: V3 = [mid.x - u.x * L / 2, R, mid.z - u.z * L / 2]
        const eb: V3 = [mid.x + u.x * L / 2, R, mid.z + u.z * L / 2]
        out.push({ kind: 'cylinder', a: ea, b: eb, radius: R, color, tag: body })
        if (diode) {
          // The cathode band, at the lead-b end (mark stripe-b).
          const off = L / 2 - 0.4 - STRIPE_MM / 2
          const s = { x: mid.x + u.x * off, z: mid.z + u.z * off }
          out.push({
            kind: 'cylinder', radius: R + STRIPE_PROUD_MM, color: COLORS.diodeStripe, tag: body,
            a: [s.x - u.x * STRIPE_MM / 2, R, s.z - u.z * STRIPE_MM / 2], b: [s.x + u.x * STRIPE_MM / 2, R, s.z + u.z * STRIPE_MM / 2]
          })
        }
        const bent = (pin: Pin, end: V3, q: XZ): Prim => ({
          kind: 'tube', radius: LEG_R, color: COLORS.leg, metal: true, tag: legTag(pin),
          points: [end, [q.x, R, q.z], [q.x, legEnd(pin), q.z]]
        })
        out.push(bent(pins[0]!, ea, a), bent(pins[1]!, eb, b))
      }
      break
    }
    default:
      // A footprint without a dedicated shape: its body box.
      out.push(rectBox(r, 0, h, COLORS.black, body))
      allStraight(0)
  }

  for (const pin of pins) {
    const top = straight.get(pin.name)
    const q = pinXZ(pin)
    if (top !== undefined)
      out.push({ kind: 'cylinder', a: [q.x, top, q.z], b: [q.x, legEnd(pin), q.z], radius: LEG_R, color: COLORS.leg, metal: true, tag: legTag(pin) })
    out.push({
      kind: 'cone', base: [q.x, BOARD_BOTTOM_Y, q.z], up: -1, radius: SOLDER_BASE_DIAMETER_MM / 2, height: SOLDER_HEIGHT_MM,
      color: COLORS.solder, metal: true,
      tag: { kind: 'joint', id: `${part.ref}.${pin.name}`, net: pin.net, ...netsOf(pin), label: `${part.ref} pin ${pin.name} joint`, owners: ['part'] }
    })
  }
  return out
}
