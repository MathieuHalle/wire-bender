<script setup lang="ts">
// One side of the board, drawn in mm. The bottom is usually mirrored (seen from below),
// so text is never drawn mirrored: every coordinate goes through `geo`.
import { holeKey, holeName, type Hole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import { placePart, type PlacedPart } from '~core/footprints'
import { buildConnectivity, type Connectivity } from '~core/connectivity'
import { litOf, makeGeo, type Group, type Tool } from '~/utils/boardView'
import { ALL_LAYERS, type Layers } from '~/utils/layers'

const props = withDefaults(defineProps<{
  board: BoardFile
  side: Side
  mirrored?: boolean
  /** The connectivity group to light up (a net as drawn, shorts included). */
  highlightNet?: Group | null
  /** Hole to ring, e.g. the one hovered on the other side. */
  hoverHole?: Hole | null
  tool?: Tool
  /** Pass these from the page to compute them once for both sides. */
  conn?: Connectivity
  placed?: PlacedPart[]
  /** While drawing on this side: the trail's last point; a rubber band follows the pointer from it. */
  drawFrom?: Hole | null
  /** Holes of the finding picked in the findings panel (a second highlight, separate from the net). */
  markHoles?: Hole[]
  /** 1 = fit the width; above 1 the side scrolls in its box. */
  zoom?: number
  /**
   * The Edit tab's view layers. A hidden layer is not drawn; hover, tooltips and clicks
   * still work on the board data (connectivity is unchanged).
   */
  layers?: Layers
}>(), { layers: () => ({ ...ALL_LAYERS }), zoom: 1, mirrored: false, highlightNet: null, hoverHole: null, tool: 'inspect', conn: undefined, placed: undefined, drawFrom: null, markHoles: () => [] })

const emit = defineEmits<{
  'hole-click': [hole: Hole]
  'segment-click': [a: Hole, b: Hole]
  'hover': [hole: Hole | null]
}>()

const MARGIN = 3
const LABEL = 1.25 // font size, mm

const geo = computed(() => makeGeo(props.board, props.mirrored))
const placedParts = computed(() => props.placed ?? props.board.parts.map(placePart))
const connectivity = computed(() => props.conn ?? buildConnectivity(props.board))
const lit = computed(() => litOf(props.highlightNet))

/** Board outline (half a pitch past the outer holes) and everything that overhangs it. */
const extent = computed(() => {
  const g = geo.value
  const half = g.pitch / 2
  let x0 = -half
  let y0 = -half
  let x1 = g.span + half
  let y1 = (g.rows - 1) * g.pitch + half
  for (const p of placedParts.value) {
    const r = g.rect(p.bodyRectMm)
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x0, y0, x1, y1 }
})
const viewBox = computed(() => {
  const e = extent.value
  return `${e.x0 - MARGIN} ${e.y0 - MARGIN} ${e.x1 - e.x0 + 2 * MARGIN} ${e.y1 - e.y0 + 2 * MARGIN}`
})

const colLabels = computed(() =>
  Array.from({ length: geo.value.cols }, (_, i) => ({ n: i + 1, x: geo.value.pt({ col: i + 1, row: 1 }).x })))
const rowLabels = computed(() =>
  Array.from({ length: geo.value.rows }, (_, i) => ({
    name: holeName({ col: 1, row: i + 1 }).replace(/\d+$/, ''),
    y: geo.value.pt({ col: 1, row: i + 1 }).y
  })))

// ---- Zoom: keep the centre of the view where it was --------------------------------
const scroller = ref<HTMLDivElement | null>(null)
watch(() => props.zoom, async (z, old) => {
  const el = scroller.value
  if (!el || !old) return
  const cx = (el.scrollLeft + el.clientWidth / 2) / old
  const cy = (el.scrollTop + el.clientHeight / 2) / old
  await nextTick()
  el.scrollLeft = cx * z - el.clientWidth / 2
  el.scrollTop = cy * z - el.clientHeight / 2
})

// ---- Pointer -> hole / segment ------------------------------------------------------
const svgEl = ref<SVGSVGElement | null>(null)
const hovered = ref<Hole | null>(null)
const tipAt = ref<{ x: number, y: number, flip: boolean } | null>(null)
/** Pointer in fractional hole coordinates (col, row), while over the board. */
const pointer = ref<{ fc: number, fr: number } | null>(null)

function boardPoint(ev: PointerEvent | MouseEvent) {
  const svg = svgEl.value
  const ctm = svg?.getScreenCTM()
  if (!svg || !ctm) return null
  const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse())
  const g = geo.value
  return { fc: geo.value.x(p.x) / g.pitch + 1, fr: p.y / g.pitch + 1 }
}

function inBoard(h: Hole) {
  return h.col >= 1 && h.row >= 1 && h.col <= geo.value.cols && h.row <= geo.value.rows
}

function holeAt(fc: number, fr: number): Hole | null {
  const h = { col: Math.round(fc), row: Math.round(fr) }
  if (!inBoard(h) || Math.hypot(fc - h.col, fr - h.row) > 0.5) return null
  return h
}

function onMove(ev: PointerEvent) {
  const p = boardPoint(ev)
  pointer.value = p
  const h = p ? holeAt(p.fc, p.fr) : null
  const wrap = svgEl.value?.parentElement?.getBoundingClientRect()
  tipAt.value = h && wrap
    ? { x: ev.clientX - wrap.left, y: ev.clientY - wrap.top, flip: ev.clientX - wrap.left > wrap.width * 0.6 }
    : null
  if (h?.col === hovered.value?.col && h?.row === hovered.value?.row) return
  hovered.value = h
  emit('hover', h)
}

function onLeave() {
  tipAt.value = null
  pointer.value = null
  if (hovered.value) emit('hover', null)
  hovered.value = null
}

function onClick(ev: MouseEvent) {
  const p = boardPoint(ev)
  if (!p) return
  if (props.tool === 'erase') {
    // Between two neighbouring holes along a row or column: that segment.
    const c = Math.round(p.fc)
    const r = Math.round(p.fr)
    const midC = Math.floor(p.fc)
    const midR = Math.floor(p.fr)
    if (Math.abs(p.fr - r) < 0.25 && Math.abs(p.fc - midC - 0.5) < 0.3) {
      const a = { col: midC, row: r }
      const b = { col: midC + 1, row: r }
      if (inBoard(a) && inBoard(b)) return emit('segment-click', a, b)
    }
    if (Math.abs(p.fc - c) < 0.25 && Math.abs(p.fr - midR - 0.5) < 0.3) {
      const a = { col: c, row: midR }
      const b = { col: c, row: midR + 1 }
      if (inBoard(a) && inBoard(b)) return emit('segment-click', a, b)
    }
  }
  const h = holeAt(p.fc, p.fr)
  if (h) emit('hole-click', h)
}

// ---- Tooltip ------------------------------------------------------------------------
const pinAt = computed(() => {
  const m = new Map<string, string[]>()
  for (const p of placedParts.value)
    for (const pin of p.pins) {
      const k = holeKey(pin.hole)
      m.set(k, [...(m.get(k) ?? []), `${p.part.ref} pin ${pin.name}`])
    }
  return m
})

const tip = computed(() => {
  const h = hovered.value
  if (!h) return null
  const pins = pinAt.value.get(holeKey(h)) ?? []
  const net = connectivity.value.netAtHole(h, props.side)
  const nets = props.highlightNet?.nets ?? []
  const netText = net ?? (nets.length > 1 ? `short: ${nets.join(' + ')}` : nets[0] ?? 'no net')
  return { name: holeName(h), pins, net: netText }
})

// ---- Rubber band and finding marks -------------------------------------------------
/** From the last drawn point to the pointer, snapped to that point's row or column. */
const band = computed(() => {
  const from = props.drawFrom
  const p = pointer.value
  if (!from || !p) return null
  const g = geo.value
  const clamp = (v: number, max: number) => Math.min(max, Math.max(1, Math.round(v)))
  const to = Math.abs(p.fc - from.col) >= Math.abs(p.fr - from.row)
    ? { col: clamp(p.fc, g.cols), row: from.row }
    : { col: from.col, row: clamp(p.fr, g.rows) }
  return { a: g.pt(from), b: g.pt(to) }
})

const marks = computed(() => props.markHoles.map(h => ({ k: holeKey(h), ...geo.value.pt(h) })))

const ringed = computed(() => {
  const h = hovered.value ?? props.hoverHole
  return h ? geo.value.pt(h) : null
})
</script>

<template>
  <div class="relative">
    <div
      ref="scroller"
      class="overflow-auto"
      :class="zoom > 1 ? 'max-h-[80vh] rounded border border-default' : ''"
    >
      <svg
        ref="svgEl"
        :viewBox="viewBox"
        :style="{ width: `${zoom * 100}%` }"
        class="mx-auto block h-auto max-w-none select-none"
        :class="tool === 'inspect' ? 'cursor-default' : 'cursor-crosshair'"
        font-family="'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace"
        role="img"
        :aria-label="`Board ${side} side${mirrored ? ', mirrored (seen from below)' : ''}`"
        @pointermove="onMove"
        @pointerleave="onLeave"
        @click="onClick"
      >
        <BoardHoles
          :board="board"
          :side="side"
          :geo="geo"
          :lit="lit"
        />
        <BoardCopper
          v-if="layers.trails"
          :board="board"
          :side="side"
          :geo="geo"
          :lit="lit"
          :conn="connectivity"
          :placed="placedParts"
        />
        <BoardParts
          v-if="layers.components"
          :board="board"
          :side="side"
          :geo="geo"
          :lit="lit"
          :placed="placedParts"
        />
        <BoardWires
          v-if="layers.wires"
          :board="board"
          :side="side"
          :geo="geo"
          :lit="lit"
        />

        <!-- edge labels: columns top and bottom, rows left and right -->
        <g
          fill="#5b6a62"
          :font-size="LABEL"
          text-anchor="middle"
          dominant-baseline="central"
          pointer-events="none"
        >
          <template
            v-for="c in colLabels"
            :key="`c${c.n}`"
          >
            <text
              :x="c.x"
              :y="extent.y0 - MARGIN / 2"
            >{{ c.n }}</text>
            <text
              :x="c.x"
              :y="extent.y1 + MARGIN / 2"
            >{{ c.n }}</text>
          </template>
          <template
            v-for="r in rowLabels"
            :key="`r${r.name}`"
          >
            <text
              :x="extent.x0 - MARGIN / 2"
              :y="r.y"
            >{{ r.name }}</text>
            <text
              :x="extent.x1 + MARGIN / 2"
              :y="r.y"
            >{{ r.name }}</text>
          </template>
        </g>

        <g
          v-if="marks.length"
          pointer-events="none"
        >
          <circle
            v-for="m in marks"
            :key="m.k"
            :cx="m.x"
            :cy="m.y"
            r="1.5"
            fill="none"
            stroke="#e11d48"
            stroke-width="0.4"
            stroke-dasharray="0.8 0.4"
          />
        </g>

        <g
          v-if="band"
          pointer-events="none"
        >
          <line
            :x1="band.a.x"
            :y1="band.a.y"
            :x2="band.b.x"
            :y2="band.b.y"
            stroke="#f5b400"
            stroke-width="0.6"
            stroke-linecap="round"
            stroke-dasharray="1 0.6"
            opacity="0.9"
          />
          <circle
            :cx="band.b.x"
            :cy="band.b.y"
            r="0.5"
            fill="#f5b400"
          />
        </g>

        <circle
          v-if="ringed"
          :cx="ringed.x"
          :cy="ringed.y"
          r="1.15"
          fill="none"
          stroke="#f5b400"
          stroke-width="0.35"
          pointer-events="none"
        />
      </svg>
    </div>

    <div
      v-if="tip && tipAt"
      class="pointer-events-none absolute z-10 w-max rounded-md border border-default bg-default px-2 py-1 font-mono text-xs whitespace-nowrap shadow-md"
      :style="tipAt.flip
        ? { right: `calc(100% - ${tipAt.x - 14}px)`, top: `${tipAt.y + 14}px` }
        : { left: `${tipAt.x + 14}px`, top: `${tipAt.y + 14}px` }"
    >
      <div class="font-semibold">
        {{ tip.name }}
      </div>
      <div
        v-for="p in tip.pins"
        :key="p"
      >
        {{ p }}
      </div>
      <div class="text-muted">
        {{ tip.net }}
      </div>
    </div>
  </div>
</template>
