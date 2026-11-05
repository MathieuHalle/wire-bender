<script setup lang="ts">
// The board itself: outline, every hole (with its pad ring on sides that have pads),
// blocked holes crossed, and lit pads of the highlighted group.
import { holeKey, parseHole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import type { Geo, Lit } from '~/utils/boardView'

const props = defineProps<{ board: BoardFile, side: Side, geo: Geo, lit: Lit | null }>()

const hasPads = computed(() => props.side === 'bottom' || props.board.board.type === 'two-sided')

const outline = computed(() => {
  const g = props.geo
  const half = g.pitch / 2
  return { x: -half, y: -half, w: g.span + g.pitch, h: g.rows * g.pitch }
})

const holes = computed(() => {
  const out: { k: string, x: number, y: number }[] = []
  for (let row = 1; row <= props.geo.rows; row++)
    for (let col = 1; col <= props.geo.cols; col++) {
      const p = props.geo.pt({ col, row })
      out.push({ k: holeKey({ col, row }), ...p })
    }
  return out
})

const blocked = computed(() =>
  props.board.board.blocked.flatMap(b => b.holes.map(n => ({ n, ...props.geo.pt(parseHole(n)) }))))

const litPads = computed(() => {
  const l = props.lit
  if (!l) return []
  return holes.value.filter(h => l.pads.has(`${h.k}|${props.side}`))
})
</script>

<template>
  <g pointer-events="none">
    <rect
      :x="outline.x"
      :y="outline.y"
      :width="outline.w"
      :height="outline.h"
      rx="0.6"
      :fill="side === 'top' ? '#e4efe7' : '#dde8e0'"
      stroke="#b7cbbd"
      stroke-width="0.25"
    />
    <g v-if="hasPads">
      <circle
        v-for="h in holes"
        :key="`p${h.k}`"
        :cx="h.x"
        :cy="h.y"
        r="0.85"
        fill="#c4cfc8"
        stroke="#a6b5ab"
        stroke-width="0.12"
      />
    </g>
    <circle
      v-for="h in litPads"
      :key="`l${h.k}`"
      :cx="h.x"
      :cy="h.y"
      r="1.05"
      fill="#f5b400"
      fill-opacity="0.55"
    />
    <circle
      v-for="h in holes"
      :key="`d${h.k}`"
      :cx="h.x"
      :cy="h.y"
      r="0.45"
      fill="#6f7d75"
    />
    <g
      stroke="#c8321e"
      stroke-width="0.3"
      stroke-linecap="round"
    >
      <path
        v-for="b in blocked"
        :key="`b${b.n}`"
        :d="`M${b.x - 0.8} ${b.y - 0.8}L${b.x + 0.8} ${b.y + 0.8}M${b.x + 0.8} ${b.y - 0.8}L${b.x - 0.8} ${b.y + 0.8}`"
      />
    </g>
  </g>
</template>
