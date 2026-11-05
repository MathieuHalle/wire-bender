<script setup lang="ts">
// Insulated wires on one side: laid wires along their path in their colour (bare
// stretches thinner), flying wires as coloured end dots labelled with the wire id.
import { parseHole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import { FALLBACK_NET, type Geo, type Lit } from '~/utils/boardView'

const props = defineProps<{ board: BoardFile, side: Side, geo: Geo, lit: Lit | null }>()

const wires = computed(() => props.board.wires.filter(w => w.side === props.side).map((w) => {
  const pts = w.points.map(h => props.geo.pt(parseHole(h)))
  const seg = (i: number) => `M${pts[i]!.x} ${pts[i]!.y}L${pts[i + 1]!.x} ${pts[i + 1]!.y}`
  const segs = pts.slice(0, -1).map((_, i) => ({ d: seg(i), bare: w.bareSegments.includes(i) }))
  return {
    id: w.id,
    flying: w.kind === 'flying',
    color: w.color ?? FALLBACK_NET,
    segs,
    ends: [pts[0]!, pts[pts.length - 1]!],
    joints: w.joints.map(h => props.geo.pt(parseHole(h))),
    lit: props.lit?.ids.has(`wire:${w.id}`) ?? false
  }
}))

const dim = (lit: boolean) => (props.lit && !lit ? 0.35 : 1)
</script>

<template>
  <g pointer-events="none">
    <g
      v-for="w in wires"
      :key="w.id"
      :opacity="dim(w.lit)"
    >
      <template v-if="!w.flying">
        <template
          v-for="(s, i) in w.segs"
          :key="i"
        >
          <path
            v-if="w.lit"
            :d="s.d"
            stroke="#f5b400"
            stroke-opacity="0.6"
            stroke-width="2.4"
            stroke-linecap="round"
          />
          <path
            v-if="!s.bare"
            :d="s.d"
            stroke="#16201b"
            stroke-opacity="0.6"
            stroke-width="1.5"
            stroke-linecap="round"
          />
          <path
            :d="s.d"
            :stroke="s.bare ? '#b0b8bc' : w.color"
            :stroke-width="s.bare ? 0.6 : 1.2"
            stroke-linecap="round"
          />
        </template>
        <circle
          v-for="(p, i) in w.joints"
          :key="`j${i}`"
          :cx="p.x"
          :cy="p.y"
          r="0.95"
          fill="#c3cacf"
          stroke="#7c868c"
          stroke-width="0.15"
        />
      </template>
      <template
        v-for="(p, i) in w.ends"
        :key="`e${i}`"
      >
        <circle
          v-if="w.lit"
          :cx="p.x"
          :cy="p.y"
          r="1.4"
          fill="#f5b400"
          fill-opacity="0.6"
        />
        <circle
          :cx="p.x"
          :cy="p.y"
          r="0.85"
          :fill="w.color"
          stroke="#ffffff"
          stroke-width="0.22"
        />
        <text
          v-if="w.flying"
          :x="p.x + 1.05"
          :y="p.y - 1.05"
          font-size="1.05"
          font-weight="600"
          :fill="w.color"
          stroke="#ffffff"
          stroke-width="0.3"
          paint-order="stroke"
        >
          {{ w.id }}
        </text>
      </template>
    </g>
  </g>
</template>
