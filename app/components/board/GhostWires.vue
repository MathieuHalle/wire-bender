<script setup lang="ts">
// The other side's wires as thin dashed lines, styled like the bottom's part outlines.
// Drawing only: no pointer events, no highlight, no effect on hit-testing or the check.
import { ghostWires } from '~core/sideView'
import type { BoardFile, Side } from '~core/schema'
import type { Geo } from '~/utils/boardView'

const props = defineProps<{ board: BoardFile, side: Side, geo: Geo }>()

const ghosts = computed(() => ghostWires(props.board, props.side, props.geo.mirrored).map(w => ({
  id: w.id,
  d: w.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('')
})))
</script>

<template>
  <g
    v-if="ghosts.length"
    pointer-events="none"
    fill="none"
    stroke="#16201b"
    stroke-opacity="0.55"
    stroke-width="0.22"
    stroke-dasharray="0.7 0.45"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path
      v-for="w in ghosts"
      :key="w.id"
      :data-ghost="w.id"
      :d="w.d"
    />
  </g>
</template>
