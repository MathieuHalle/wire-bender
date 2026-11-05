<script setup lang="ts">
// Solder-side copper of one side: trails (thick lines, joints as blobs, holes passed
// over keep their ring), solder bridges and leg-folds.
import { holeKey, parseHole, type Hole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import type { PlacedPart } from '~core/footprints'
import type { Connectivity } from '~core/connectivity'
import { conductorKey, netColor, NO_NET, polyHoles, type Geo, type Lit } from '~/utils/boardView'

const props = defineProps<{
  board: BoardFile
  side: Side
  geo: Geo
  lit: Lit | null
  conn: Connectivity
  placed: PlacedPart[]
}>()

const SHORT = '#d6008f'

const groupOf = computed(() => {
  const m = new Map<string, number>()
  props.conn.groups.forEach((g, i) => g.conductors.forEach(c => m.set(conductorKey(c), i)))
  return m
})

function colorOfGroup(gi: number | undefined): string {
  if (gi === undefined) return NO_NET
  const nets = props.conn.groups[gi]!.nets
  if (nets.length > 1) return SHORT
  return netColor(props.board, nets[0])
}

const trails = computed(() => props.board.trails.filter(t => t.side === props.side && t.points.length).map((t) => {
  const pts = t.points.map(parseHole)
  const ends = [pts[0]!, pts[pts.length - 1]!]
  const jointKeys = new Set([...ends, ...t.joints.map(parseHole)].map(holeKey))
  const joints = [...new Map([...ends, ...t.joints.map(parseHole)].map(h => [holeKey(h), h])).values()]
  const over = polyHoles(pts).filter(h => !jointKeys.has(holeKey(h)))
  const id = `trail:${t.id}`
  return {
    id: t.id,
    d: pts.map((h, i) => `${i ? 'L' : 'M'}${props.geo.pt(h).x} ${props.geo.pt(h).y}`).join(''),
    color: colorOfGroup(groupOf.value.get(id)),
    joints: joints.map(h => props.geo.pt(h)),
    over: over.map(h => props.geo.pt(h)),
    lit: props.lit?.ids.has(id) ?? false
  }
}))

const bridges = computed(() => props.board.solderBridges.filter(b => b.side === props.side).map((b) => {
  const a = parseHole(b.a)
  const c = parseHole(b.b)
  const gi = groupOf.value.get(conductorKey({ kind: 'pad', hole: a, side: b.side }))
  return {
    k: `${b.a}-${b.b}`,
    a: props.geo.pt(a),
    b: props.geo.pt(c),
    color: colorOfGroup(gi),
    lit: props.lit?.pads.has(`${holeKey(a)}|${b.side}`) ?? false
  }
}))

const leadHole = computed(() => {
  const m = new Map<string, Hole>()
  for (const p of props.placed) for (const pin of p.pins) m.set(`${p.part.ref}.${pin.name}`, pin.hole)
  return m
})

/** Leg-folds are bent on the solder side (bottom). */
const folds = computed(() => {
  if (props.side !== 'bottom') return []
  return props.board.legFolds.flatMap((f) => {
    const from = leadHole.value.get(f.lead)
    if (!from) return []
    const a = props.geo.pt(from)
    const b = props.geo.pt(parseHole(f.to))
    // A short bend: leave the hole a little off-axis, then lie down onto the target pad.
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const k = { x: a.x + dx * 0.3 - (dy / len) * 0.55, y: a.y + dy * 0.3 + (dx / len) * 0.55 }
    const id = `lead:${f.lead}`
    return [{
      k: `${f.lead}>${f.to}`,
      d: `M${a.x} ${a.y}L${k.x} ${k.y}L${b.x} ${b.y}`,
      b,
      color: colorOfGroup(groupOf.value.get(id)),
      lit: props.lit?.ids.has(id) ?? false
    }]
  })
})

const dim = (lit: boolean) => (props.lit && !lit ? 0.35 : 1)
</script>

<template>
  <g pointer-events="none">
    <!-- glow under lit copper -->
    <g
      stroke="#f5b400"
      stroke-opacity="0.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="none"
    >
      <path
        v-for="t in trails.filter(x => x.lit)"
        :key="`g${t.id}`"
        :d="t.d"
        stroke-width="2.2"
      />
      <line
        v-for="b in bridges.filter(x => x.lit)"
        :key="`g${b.k}`"
        :x1="b.a.x"
        :y1="b.a.y"
        :x2="b.b.x"
        :y2="b.b.y"
        stroke-width="2.6"
      />
    </g>

    <g
      v-for="t in trails"
      :key="t.id"
      :opacity="dim(t.lit)"
    >
      <path
        :d="t.d"
        fill="none"
        :stroke="t.color"
        stroke-width="0.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle
        v-for="(p, i) in t.over"
        :key="`o${i}`"
        :cx="p.x"
        :cy="p.y"
        r="0.45"
        fill="#6f7d75"
        stroke="#eef3ef"
        stroke-width="0.2"
      />
      <circle
        v-for="(p, i) in t.joints"
        :key="`j${i}`"
        :cx="p.x"
        :cy="p.y"
        r="1"
        :fill="t.color"
        stroke="#000"
        stroke-opacity="0.25"
        stroke-width="0.12"
      />
    </g>

    <g
      v-for="b in bridges"
      :key="b.k"
      :opacity="dim(b.lit)"
    >
      <line
        :x1="b.a.x"
        :y1="b.a.y"
        :x2="b.b.x"
        :y2="b.b.y"
        stroke="#7c868c"
        stroke-width="1.9"
        stroke-linecap="round"
      />
      <line
        :x1="b.a.x"
        :y1="b.a.y"
        :x2="b.b.x"
        :y2="b.b.y"
        stroke="#c3cacf"
        stroke-width="1.5"
        stroke-linecap="round"
      />
      <line
        :x1="b.a.x"
        :y1="b.a.y"
        :x2="b.b.x"
        :y2="b.b.y"
        :stroke="b.color"
        stroke-width="0.4"
        stroke-linecap="round"
      />
    </g>

    <g
      v-for="f in folds"
      :key="f.k"
      :opacity="dim(f.lit)"
    >
      <path
        :d="f.d"
        fill="none"
        stroke="#4b555b"
        stroke-width="0.85"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        :d="f.d"
        fill="none"
        :stroke="f.color"
        stroke-width="0.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle
        :cx="f.b.x"
        :cy="f.b.y"
        r="0.85"
        :fill="f.color"
        stroke="#000"
        stroke-opacity="0.25"
        stroke-width="0.12"
      />
    </g>
  </g>
</template>
