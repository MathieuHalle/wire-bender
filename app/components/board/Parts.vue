<script setup lang="ts">
// Part bodies at real size (solid on top, dashed ghost on the bottom), leads on both
// sides, and orientation marks (pin 1, TO-220 tab, diode stripe). A part lit as a whole
// (`part:<ref>`, hovered in the Layers tab) is ringed.
import { holeMm } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import type { PlacedPart } from '~core/footprints'
import { netColor, type Geo, type Lit } from '~/utils/boardView'

const props = defineProps<{ board: BoardFile, side: Side, geo: Geo, lit: Lit | null, placed: PlacedPart[] }>()

type Pt = { x: number, y: number }

const top = computed(() => props.side === 'top')

const parts = computed(() => props.placed.map((p) => {
  const g = props.geo
  const pitch = props.board.board.pitchMm
  const mm = (h: { col: number, row: number }) => holeMm(h, pitch) // board mm, unmirrored
  const v = (q: Pt): Pt => ({ x: g.x(q.x), y: g.y(q.y) }) // -> drawing mm
  const r = p.bodyRectMm
  const centre = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  const round = !!(p.part.standing && p.fp.twoLead)
  const marks: { d: string, w: number, color: string }[] = []
  const line = (a: Pt, b: Pt, w: number, color: string) => {
    const A = v(a)
    const B = v(b)
    marks.push({ d: `M${A.x} ${A.y}L${B.x} ${B.y}`, w, color })
  }

  const pinPts = p.pins.map(pin => mm(pin.hole))
  if (p.fp.mark === 'pin1') {
    const p1 = mm(p.pins.find(x => x.name === '1')?.hole ?? p.pins[0]!.hole)
    const dx = centre.x - p1.x
    const dy = centre.y - p1.y
    const len = Math.hypot(dx, dy) || 1
    const q = { x: p1.x + (dx / len) * 1.6, y: p1.y + (dy / len) * 1.6 }
    marks.push({ d: `M${v(q).x - 0.01} ${v(q).y}l0.02 0`, w: 0.9, color: '#16201b' }) // a dot
  } else if ((p.fp.mark === 'tab' || p.fp.mark === 'flat') && !round) {
    // The body edge on the tab side; without an explicit tab, the edge farthest from the leads.
    const cx = pinPts.reduce((s, q) => s + q.x, 0) / pinPts.length
    const cy = pinPts.reduce((s, q) => s + q.y, 0) / pinPts.length
    const i = 0.3
    // Top (-y), bottom (+y), left (-x), right (+x).
    const edges: [Pt, Pt][] = [
      [{ x: r.x + i, y: r.y + i }, { x: r.x + r.w - i, y: r.y + i }],
      [{ x: r.x + i, y: r.y + r.h - i }, { x: r.x + r.w - i, y: r.y + r.h - i }],
      [{ x: r.x + i, y: r.y + i }, { x: r.x + i, y: r.y + r.h - i }],
      [{ x: r.x + r.w - i, y: r.y + i }, { x: r.x + r.w - i, y: r.y + r.h - i }]
    ]
    const t = p.tab
    const far = t
      ? edges[t.dx !== 0 ? (t.dx > 0 ? 3 : 2) : (t.dy > 0 ? 1 : 0)]!
      : edges.reduce((best, e) => {
          const d = (e: [Pt, Pt]) => Math.hypot((e[0].x + e[1].x) / 2 - cx, (e[0].y + e[1].y) / 2 - cy)
          return d(e) > d(best) ? e : best
        })
    line(far[0], far[1], p.fp.mark === 'tab' ? 0.9 : 0.35, p.fp.mark === 'tab' ? '#8d969b' : '#16201b')
  } else if (p.fp.mark === 'stripe-b' && pinPts.length === 2) {
    const [a, b] = pinPts as [Pt, Pt]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const u = { x: dx / len, y: dy / len }
    const n = { x: -u.y, y: u.x }
    if (round) {
      // Standing: lead b is the one looped over the top; tick it.
      const s = { x: b.x - u.x * 0.9, y: b.y - u.y * 0.9 }
      line({ x: s.x + n.x * 0.8, y: s.y + n.y * 0.8 }, { x: s.x - n.x * 0.8, y: s.y - n.y * 0.8 }, 0.45, '#16201b')
    } else {
      const half = p.fp.body.rect.h / 2
      const s = { x: centre.x + u.x * p.fp.body.rect.w * 0.3, y: centre.y + u.y * p.fp.body.rect.w * 0.3 }
      line({ x: s.x + n.x * half, y: s.y + n.y * half }, { x: s.x - n.x * half, y: s.y - n.y * half }, 0.7, '#3b3f42')
    }
  }

  const body = g.rect(r)
  const font = Math.min(1.8, Math.max(0.8, Math.min(r.w, r.h) * 0.45))
  const two = p.fp.twoLead && pinPts.length === 2
  return {
    ref: p.part.ref,
    /** Lit as a whole: the part hovered in the Layers tab. */
    lit: props.lit?.ids.has(`part:${p.part.ref}`) ?? false,
    body,
    round,
    c: v(centre),
    font,
    marks,
    // Lead wire from a to b on top: under a lying body, looped over for a standing one.
    lead: two ? `M${v(pinPts[0]!).x} ${v(pinPts[0]!).y}L${v(pinPts[1]!).x} ${v(pinPts[1]!).y}` : null,
    pins: p.pins.map(pin => ({
      id: `lead:${p.part.ref}.${pin.name}`,
      ...g.pt(pin.hole),
      square: p.fp.mark === 'pin1' && pin.name === '1',
      color: pin.net ? netColor(props.board, pin.net) : '#ffffff',
      nc: !pin.net
    }))
  }
}))

const dim = (id: string) => (props.lit && !props.lit.ids.has(id) ? 0.45 : 1)
</script>

<template>
  <g pointer-events="none">
    <!-- glow round a part lit as a whole -->
    <g
      fill="none"
      stroke="#f5b400"
      stroke-opacity="0.7"
      stroke-width="0.9"
    >
      <template
        v-for="p in parts.filter(x => x.lit)"
        :key="`g${p.ref}`"
      >
        <circle
          v-if="p.round"
          :cx="p.c.x"
          :cy="p.c.y"
          :r="p.body.w / 2 + 0.3"
        />
        <rect
          v-else
          :x="p.body.x - 0.3"
          :y="p.body.y - 0.3"
          :width="p.body.w + 0.6"
          :height="p.body.h + 0.6"
          rx="0.6"
        />
      </template>
    </g>
    <template v-if="top">
      <g
        v-for="p in parts"
        :key="p.ref"
      >
        <path
          v-if="p.lead"
          :d="p.lead"
          stroke="#8d969b"
          stroke-width="0.55"
          stroke-linecap="round"
        />
        <circle
          v-if="p.round"
          :cx="p.c.x"
          :cy="p.c.y"
          :r="p.body.w / 2"
          fill="#ffffff"
          fill-opacity="0.85"
          stroke="#16201b"
          stroke-width="0.2"
        />
        <rect
          v-else
          :x="p.body.x"
          :y="p.body.y"
          :width="p.body.w"
          :height="p.body.h"
          rx="0.4"
          fill="#ffffff"
          fill-opacity="0.8"
          stroke="#16201b"
          stroke-width="0.2"
        />
        <path
          v-for="(m, i) in p.marks"
          :key="i"
          :d="m.d"
          :stroke="m.color"
          :stroke-width="m.w"
          stroke-linecap="round"
        />
      </g>
    </template>
    <template v-else>
      <g
        v-for="p in parts"
        :key="p.ref"
        fill="none"
        stroke="#16201b"
        stroke-opacity="0.55"
        stroke-width="0.18"
        stroke-dasharray="0.7 0.45"
      >
        <circle
          v-if="p.round"
          :cx="p.c.x"
          :cy="p.c.y"
          :r="p.body.w / 2"
        />
        <rect
          v-else
          :x="p.body.x"
          :y="p.body.y"
          :width="p.body.w"
          :height="p.body.h"
          rx="0.4"
        />
      </g>
    </template>

    <!-- leads: pins on top, lead ends on the solder side -->
    <template
      v-for="p in parts"
      :key="`pins${p.ref}`"
    >
      <template
        v-for="pin in p.pins"
        :key="pin.id"
      >
        <circle
          v-if="lit?.ids.has(pin.id)"
          :cx="pin.x"
          :cy="pin.y"
          r="1.15"
          fill="none"
          stroke="#f5b400"
          stroke-width="0.4"
        />
        <rect
          v-if="top && pin.square"
          :x="pin.x - 0.55"
          :y="pin.y - 0.55"
          width="1.1"
          height="1.1"
          :fill="pin.color"
          stroke="#16201b"
          stroke-width="0.15"
          :opacity="dim(pin.id)"
        />
        <circle
          v-else
          :cx="pin.x"
          :cy="pin.y"
          :r="top ? 0.55 : 0.38"
          :fill="pin.color"
          :stroke="top ? '#16201b' : '#eef3ef'"
          :stroke-width="top ? 0.15 : 0.14"
          :opacity="dim(pin.id)"
        />
      </template>
    </template>

    <text
      v-for="p in parts"
      :key="`t${p.ref}`"
      :x="p.c.x"
      :y="p.c.y"
      :font-size="p.font"
      text-anchor="middle"
      dominant-baseline="central"
      font-weight="600"
      :fill="top ? '#16201b' : '#5b6a62'"
      :fill-opacity="top ? 1 : 0.8"
      stroke="#ffffff"
      stroke-width="0.35"
      stroke-opacity="0.85"
      paint-order="stroke"
    >
      {{ p.ref }}
    </text>
  </g>
</template>
