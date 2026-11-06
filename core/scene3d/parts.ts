import { bodyHeightMm, FOOTPRINT_PITCH_MM, type PlacedPart, type Rect } from '../footprints'
import { holeMm } from '../holes'
import {
  BOARD_BOTTOM_Y, COLORS, LEG_DIAMETER_MM, LEG_END_Y, SOLDER_BASE_DIAMETER_MM, SOLDER_HEIGHT_MM
} from './dims'
import type { Prim, Tag, V3 } from './types'

const LEG_R = LEG_DIAMETER_MM / 2
/** DIP packages stand on their lead shoulders. */
const DIP_LIFT_MM = 0.5
const HEADER_BAR_MM = 2.5
const HEADER_POST_MM = 0.64
const TO220_TAB_MM = 1.3
const TO220_TAB_ABOVE_MM = 6
/** Radial parts (polyfuse) stand on kinked leads. */
const RADIAL_LIFT_MM = 2
const STANDING_LOOP_MM = 0.8
const STRIPE_MM = 0.8

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

function isDiode(pp: PlacedPart): boolean {
  return /diode|\b1N\d{4}/i.test(`${pp.part.value ?? ''} ${pp.part.label ?? ''}`)
}

/** Body prims, legs and the solder joint under each leg for one placed part. */
export function partPrims(pp: PlacedPart): Prim[] {
  const { part, fp, pins, bodyRectMm: r } = pp
  const h = bodyHeightMm(part, fp)
  const body: Tag = { kind: 'part', id: part.ref, label: part.label ?? part.ref }
  const legTag = (pin: Pin): Tag => ({ kind: 'leg', id: `${part.ref}.${pin.name}`, net: pin.net, label: `${part.ref} pin ${pin.name}` })
  const out: Prim[] = []
  /** Pin name -> leg top y for straight legs; tubes go in `out` directly. */
  const straight = new Map<string, number>()

  const two = fp.twoLead ? { a: pinXZ(pins[0]!), b: pinXZ(pins[1]!) } : null
  const axis = two ? leadAxis(two.a, two.b) : null
  const allStraight = (top: number) => pins.forEach(p => straight.set(p.name, top))

  switch (fp.id) {
    case 'relay-g5v2':
      out.push(rectBox(r, 0, h, COLORS.relay, body))
      allStraight(0)
      break
    case 'to220-gds': {
      out.push(rectBox(r, 0, h - TO220_TAB_ABOVE_MM, COLORS.black, body))
      // The tab is on the body face farthest from the leads.
      const pc = pins.map(pinXZ)
      const px = pc.reduce((s, q) => s + q.x, 0) / pc.length
      const pz = pc.reduce((s, q) => s + q.z, 0) / pc.length
      const dx = r.x + r.w / 2 - px
      const dz = r.y + r.h / 2 - pz
      const t = TO220_TAB_MM
      const tab: Rect = Math.abs(dx) > Math.abs(dz)
        ? { x: dx > 0 ? r.x + r.w : r.x - t, y: r.y, w: t, h: r.h }
        : { x: r.x, y: dz > 0 ? r.y + r.h : r.y - t, w: r.w, h: t }
      out.push(rectBox(tab, 0, h, COLORS.tab, body))
      allStraight(0)
      break
    }
    case 'dip8':
      out.push(rectBox(r, DIP_LIFT_MM, DIP_LIFT_MM + h, COLORS.black, body))
      allStraight(DIP_LIFT_MM)
      break
    case 'terminal-2p-508':
      out.push(rectBox(r, 0, h, COLORS.terminal, body))
      allStraight(0)
      break
    case 'header-1x5':
      out.push(rectBox(r, 0, HEADER_BAR_MM, COLORS.black, body))
      for (const pin of pins) {
        const c = pinXZ(pin)
        out.push({
          kind: 'box', center: [c.x, (HEADER_BAR_MM + h) / 2, c.z], size: [HEADER_POST_MM, h - HEADER_BAR_MM, HEADER_POST_MM],
          color: COLORS.headerPin, tag: body
        })
      }
      allStraight(0)
      break
    case 'polyfuse-radial':
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
        // Vertical over lead a; lead b runs up beside the body and over the top.
        out.push({ kind: 'cylinder', a: [a.x, 0, a.z], b: [a.x, h, a.z], radius: R, color, tag: body })
        if (diode)
          out.push({ kind: 'cylinder', a: [a.x, h - STRIPE_MM - 0.4, a.z], b: [a.x, h - 0.4, a.z], radius: R + 0.05, color: COLORS.diodeStripe, tag: body })
        straight.set('a', 0)
        const top = h + STANDING_LOOP_MM
        out.push({
          kind: 'tube', radius: LEG_R, color: COLORS.leg, tag: legTag(pins[1]!),
          points: [[a.x, h, a.z], [a.x, top, a.z], [b.x, top, b.z], [b.x, LEG_END_Y, b.z]]
        })
      } else {
        // Lying on the board along the lead axis; leads bend down at the holes.
        const { u, mid } = axis!
        const L = fp.body.rect.w
        const ea: V3 = [mid.x - u.x * L / 2, R, mid.z - u.z * L / 2]
        const eb: V3 = [mid.x + u.x * L / 2, R, mid.z + u.z * L / 2]
        out.push({ kind: 'cylinder', a: ea, b: eb, radius: R, color, tag: body })
        if (diode) {
          const s = { x: mid.x + u.x * L * 0.3, z: mid.z + u.z * L * 0.3 }
          out.push({
            kind: 'cylinder', radius: R + 0.05, color: COLORS.diodeStripe, tag: body,
            a: [s.x - u.x * STRIPE_MM / 2, R, s.z - u.z * STRIPE_MM / 2], b: [s.x + u.x * STRIPE_MM / 2, R, s.z + u.z * STRIPE_MM / 2]
          })
        }
        const bent = (pin: Pin, end: V3, q: XZ): Prim => ({
          kind: 'tube', radius: LEG_R, color: COLORS.leg, tag: legTag(pin),
          points: [end, [q.x, R, q.z], [q.x, LEG_END_Y, q.z]]
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
    const c = pinXZ(pin)
    if (top !== undefined)
      out.push({ kind: 'cylinder', a: [c.x, top, c.z], b: [c.x, LEG_END_Y, c.z], radius: LEG_R, color: COLORS.leg, tag: legTag(pin) })
    out.push({
      kind: 'cone', base: [c.x, BOARD_BOTTOM_Y, c.z], up: -1, radius: SOLDER_BASE_DIAMETER_MM / 2, height: SOLDER_HEIGHT_MM,
      color: COLORS.solder, tag: { kind: 'joint', id: `${part.ref}.${pin.name}`, net: pin.net }
    })
  }
  return out
}
