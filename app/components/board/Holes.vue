<script setup lang="ts">
// The board itself: outline (its shape, if it has one), every hole it has (with its pad ring
// on sides that have pads), blocked holes crossed, and lit pads of the highlighted group.
import { existingHoles, shapeOutline } from '~core/boardShape'
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
/** A round or cut board's outline, as this side draws it (mirrored with it); null for a rectangle. */
const shape = computed(() => shapeOutline(props.board.board, props.geo))
const shapePoints = computed(() => (shape.value?.kind === 'polygon' ? shape.value.points.map(p => `${p.x},${p.y}`).join(' ') : ''))
const fill = computed(() => (props.side === 'top' ? '#e4efe7' : '#dde8e0'))

const holes = computed(() => existingHoles(props.board.board).map(h => ({ k: holeKey(h), ...props.geo.pt(h) })))

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
    <circle
      v-if="shape?.kind === 'circle'"
      :cx="shape.cx"
      :cy="shape.cy"
      :r="shape.r"
      :fill="fill"
      stroke="#b7cbbd"
      stroke-width="0.25"
    />
    <polygon
      v-else-if="shape"
      :points="shapePoints"
      :fill="fill"
      stroke="#b7cbbd"
      stroke-width="0.25"
      stroke-linejoin="round"
    />
    <rect
      v-else
      :x="outline.x"
      :y="outline.y"
      :width="outline.w"
      :height="outline.h"
      rx="0.6"
      :fill="fill"
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
