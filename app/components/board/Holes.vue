<script setup lang="ts">
// The board itself: outline (its shape, if it has one), every hole it has (with its pad ring
// on sides that have pads), blocked holes crossed, and lit pads of the highlighted group. A
// breadboard is drawn like one (ivory, square holes, the channel, red and blue rail lines); a
// stripboard's bottom shows its copper strips.
import { existingHoles, shapeOutline } from '~core/boardShape'
import { holeKey, parseHole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import type { Geo, Lit } from '~/utils/boardView'
import { channelRect, railLines, stripBands } from '~/utils/breadboardLook'
import { boardPath, mountRings, noGoCells } from '~/utils/boardPath'

const props = defineProps<{ board: BoardFile, side: Side, geo: Geo, lit: Lit | null }>()

const breadboard = computed(() => props.board.board.type === 'breadboard')
/** With cutouts or mounting holes: the board as one path with them cut out of it. */
const openingsPath = computed(() =>
  props.board.board.cutouts?.length || props.board.board.mountingHoles?.length ? boardPath(props.board, props.geo) : null)
const rings = computed(() => mountRings(props.board, props.geo))
/** No-go zones (and round mounting holes): a hatched patch on each blocked hole. */
const noGo = computed(() => noGoCells(props.board, props.geo))
// Both sides are on one page: each side's pattern has its own id.
const hatchId = computed(() => `nogo-hatch-${props.side}`)
const hasPads = computed(() => !breadboard.value && (props.side === 'bottom' || props.board.board.type === 'two-sided'))

const outline = computed(() => {
  const g = props.geo
  const half = g.pitch / 2
  return { x: -half, y: -half, w: g.span + g.pitch, h: g.rows * g.pitch }
})
/** A round or cut board's outline, as this side draws it (mirrored with it); null for a rectangle. */
const shape = computed(() => shapeOutline(props.board.board, props.geo))
const shapePoints = computed(() => (shape.value?.kind === 'polygon' ? shape.value.points.map(p => `${p.x},${p.y}`).join(' ') : ''))
const fill = computed(() => (breadboard.value ? '#f4f0e6' : props.side === 'top' ? '#e4efe7' : '#dde8e0'))
const edge = computed(() => (breadboard.value ? '#d6cdb8' : '#b7cbbd'))
const channel = computed(() => (breadboard.value ? channelRect(props.board, props.geo) : null))
const rails = computed(() => (breadboard.value ? railLines(props.board, props.geo) : []))
/** A stripboard's copper, on the bottom (a breadboard's strips are inside it, not drawn). */
const bands = computed(() => (!breadboard.value && props.side === 'bottom' ? stripBands(props.board, props.geo) : []))
/** A stripboard's cuts: a scraped ring on the bottom, a small cross on the top (so it shows from either side). */
const cuts = computed(() => (props.board.cuts ?? []).map(n => ({ n, ...props.geo.pt(parseHole(n)) })))

const holes = computed(() => existingHoles(props.board.board).map(h => ({ k: holeKey(h), ...props.geo.pt(h) })))

const blocked = computed(() =>
  props.board.board.blocked.flatMap(b => b.holes.map(n => ({ n, ...props.geo.pt(parseHole(n)) }))))

const litPads = computed(() => {
  const l = props.lit
  if (!l) return []
  // A breadboard's clips are its "bottom pads", lit from the top, the only side it shows.
  const side = breadboard.value ? 'bottom' : props.side
  return holes.value.filter(h => l.pads.has(`${h.k}|${side}`))
})
</script>

<template>
  <g pointer-events="none">
    <path
      v-if="openingsPath"
      :d="openingsPath"
      fill-rule="evenodd"
      :fill="fill"
      :stroke="edge"
      stroke-width="0.25"
      stroke-linejoin="round"
    />
    <circle
      v-else-if="shape?.kind === 'circle'"
      :cx="shape.cx"
      :cy="shape.cy"
      :r="shape.r"
      :fill="fill"
      :stroke="edge"
      stroke-width="0.25"
    />
    <polygon
      v-else-if="shape"
      :points="shapePoints"
      :fill="fill"
      :stroke="edge"
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
      :stroke="edge"
      stroke-width="0.25"
    />
    <defs>
      <pattern
        :id="hatchId"
        width="0.9"
        height="0.9"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line
          x1="0"
          y1="0"
          x2="0"
          y2="0.9"
          stroke="#c8321e"
          stroke-width="0.22"
          stroke-opacity="0.45"
        />
      </pattern>
    </defs>
    <rect
      v-for="c in noGo"
      :key="`ng${c.k}`"
      :x="c.x - geo.pitch / 2"
      :y="c.y - geo.pitch / 2"
      :width="geo.pitch"
      :height="geo.pitch"
      :fill="`url(#${hatchId})`"
    />
    <circle
      v-for="(m, i) in rings"
      :key="`mr${i}`"
      :cx="m.cx"
      :cy="m.cy"
      :r="m.r"
      fill="none"
      stroke="#8b8f86"
      stroke-width="0.25"
      stroke-dasharray="0.8 0.5"
    />
    <rect
      v-if="channel"
      :x="channel.x"
      :y="channel.y"
      :width="channel.w"
      :height="channel.h"
      fill="#e3dccb"
    />
    <g v-if="rails.length">
      <template
        v-for="(l, i) in rails"
        :key="`rail${i}`"
      >
        <line
          :x1="l.x1"
          :y1="l.y"
          :x2="l.x2"
          :y2="l.y"
          :stroke="l.color"
          stroke-width="0.3"
        />
        <text
          v-for="x in [l.x1 - 1.2, l.x2 + 1.2]"
          :key="x"
          :x="x"
          :y="l.y"
          :fill="l.color"
          font-size="1.6"
          font-weight="600"
          text-anchor="middle"
          dominant-baseline="central"
        >
          {{ l.sign === '-' ? '−' : '+' }}
        </text>
      </template>
    </g>
    <rect
      v-for="(b, i) in bands"
      :key="`band${i}`"
      :x="b.x"
      :y="b.y"
      :width="b.w"
      :height="b.h"
      rx="0.3"
      fill="#d9a56a"
      stroke="#b9854c"
      stroke-width="0.1"
    />
    <template v-if="side === 'bottom'">
      <circle
        v-for="c in cuts"
        :key="`cut${c.n}`"
        :cx="c.x"
        :cy="c.y"
        r="1.05"
        :fill="fill"
        stroke="#8a5a2b"
        stroke-width="0.18"
      />
    </template>
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
    <template v-if="breadboard">
      <rect
        v-for="h in litPads"
        :key="`l${h.k}`"
        :x="h.x - 1"
        :y="h.y - 1"
        width="2"
        height="2"
        rx="0.3"
        fill="#f5b400"
        fill-opacity="0.55"
      />
      <rect
        v-for="h in holes"
        :key="`d${h.k}`"
        :x="h.x - 0.5"
        :y="h.y - 0.5"
        width="1"
        height="1"
        rx="0.12"
        fill="#4a4a44"
      />
    </template>
    <template v-else>
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
    </template>
    <g
      v-if="side === 'top' && cuts.length"
      stroke="#8a5a2b"
      stroke-width="0.2"
      stroke-linecap="round"
    >
      <path
        v-for="c in cuts"
        :key="`ct${c.n}`"
        :d="`M${c.x - 1} ${c.y}H${c.x + 1}`"
      />
    </g>
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
