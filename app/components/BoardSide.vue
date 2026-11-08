<script setup lang="ts">
// One side of the board, drawn in mm. The bottom is usually mirrored (seen from below),
// left-right or top-bottom, so text is never drawn mirrored: every coordinate goes through
// `geo`, and every pointer position back through `geo.hole`.
import { edgeLabels } from '~core/edgeLabels'
import { holeKey, holeName, type Hole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import { placePart, type PlacedPart } from '~core/footprints'
import { buildConnectivity, type Connectivity } from '~core/connectivity'
import type { Mirror } from '~core/sideView'
import { litOf, makeGeo, SIDE_MARGIN, sideBox, sideExtent, type Group, type Lit, type Tool } from '~/utils/boardView'
import { drawnBoard, drawnPlaced } from '~/utils/hiddenItems'
import { ALL_LAYERS, type Layers } from '~/utils/layers'
import { CANVAS_CONTEXT } from '~/utils/canvasContext'

const props = withDefaults(defineProps<{
  board: BoardFile
  side: Side
  /** How this side is drawn: as it is, or mirrored left-right or top-bottom. */
  mirror?: Mirror
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
  /**
   * The view layers (the Layers tab's groups). A hidden layer is not drawn; hover, tooltips and clicks
   * still work on the board data (connectivity is unchanged).
   */
  layers?: Layers
  /**
   * Keys of single items hidden from view (`part:U1`, `wire:W3`, `trail:T7`): not drawn,
   * labels and ghosts included, and not named in the tooltip.
   */
  hidden?: ReadonlySet<string>
  /** What to light instead of `highlightNet`: one item, hovered in the Layers tab. */
  highlightLit?: Lit | null
}>(), { layers: () => ({ ...ALL_LAYERS }), hidden: () => new Set<string>(), highlightLit: null, mirror: 'none', highlightNet: null, hoverHole: null, tool: 'inspect', conn: undefined, placed: undefined, drawFrom: null, markHoles: () => [] })

const emit = defineEmits<{
  'hole-click': [hole: Hole]
  'segment-click': [a: Hole, b: Hole]
  'hover': [hole: Hole | null]
}>()

const MARGIN = SIDE_MARGIN
const LABEL = 1.25 // font size, mm
/** What the side's accessible name adds for each mirror. */
const MIRROR_LABEL: Record<Mirror, string> = {
  none: '',
  lr: ', mirrored left-right (seen from below)',
  tb: ', mirrored top-bottom (seen from below)'
}

const geo = computed(() => makeGeo(props.board, props.mirror))
const placedParts = computed(() => props.placed ?? props.board.parts.map(placePart))
const connectivity = computed(() => props.conn ?? buildConnectivity(props.board))
const lit = computed(() => props.highlightLit ?? litOf(props.highlightNet))
/** What is drawn: the board without its hidden items (connectivity stays the whole board's). */
const drawn = computed(() => drawnBoard(props.board, props.hidden))
const drawnParts = computed(() => drawnPlaced(placedParts.value, props.hidden))

/** Board outline (half a pitch past the outer holes) and everything that overhangs it. */
const extent = computed(() => sideExtent(geo.value, placedParts.value))
const viewBox = computed(() => {
  const b = sideBox(geo.value, placedParts.value)
  return `${b.x} ${b.y} ${b.w} ${b.h}`
})

/** The edge numbering, shared with the 3D view (`edgeLabels`). */
const labels = computed(() => edgeLabels(geo.value.cols, geo.value.rows))
const colLabels = computed(() =>
  labels.value.cols.map(c => ({ n: c.text, x: geo.value.pt({ col: c.col, row: 1 }).x })))
const rowLabels = computed(() =>
  labels.value.rows.map(r => ({ name: r.text, y: geo.value.pt({ col: 1, row: r.row }).y })))

// ---- Pointer -> hole / segment ------------------------------------------------------
const rootEl = ref<HTMLDivElement | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const hovered = ref<Hole | null>(null)
/** The pointer in the tooltip's box (px), and that box's size. */
const tipAt = ref<{ x: number, y: number, w: number, h: number } | null>(null)
const tipEl = ref<HTMLDivElement | null>(null)
/** The tooltip's own size, measured once drawn (it changes with its text). */
const tipSize = shallowRef({ w: 0, h: 0 })
/** Pointer in fractional hole coordinates (col, row), while over the board. */
const pointer = ref<{ fc: number, fr: number } | null>(null)
/** The canvas this side is drawn in (absent when drawn on its own). */
const canvas = inject(CANVAS_CONTEXT, null)
/** Where the pointer last was over this side, in client px. */
let lastClient: { x: number, y: number } | null = null

function boardPoint(ev: { clientX: number, clientY: number }) {
  const svg = svgEl.value
  const ctm = svg?.getScreenCTM()
  if (!svg || !ctm) return null
  const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse())
  const h = geo.value.hole(p)
  return { fc: h.col, fr: h.row }
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
  // While the canvas pans, the board moves with the pointer: nothing to update.
  if (canvas?.panning.value) return
  track(ev.clientX, ev.clientY)
}

/** Hover, tooltip and rubber band for the pointer at (cx, cy) client px. */
function track(cx: number, cy: number) {
  lastClient = { x: cx, y: cy }
  const p = boardPoint({ clientX: cx, clientY: cy })
  pointer.value = p
  const h = p ? holeAt(p.fc, p.fr) : null
  // The tooltip sits in the canvas when there is one, kept inside it.
  const box = (canvas?.overlay.value ?? rootEl.value)?.getBoundingClientRect()
  tipAt.value = h && box ? { x: cx - box.left, y: cy - box.top, w: box.width, h: box.height } : null
  if (h?.col === hovered.value?.col && h?.row === hovered.value?.row) return
  hovered.value = h
  emit('hover', h)
}

// A zoom or pan moves the board under a resting pointer: once it is drawn (and the pan
// is over), hit-test the canvas's pointer again.
if (canvas) {
  watch([canvas.camera, canvas.panning], () => {
    if (canvas.panning.value) return
    const c = canvas.pointer.value ?? lastClient
    const svg = svgEl.value
    if (!c || !svg) return
    const under = document.elementFromPoint(c.x, c.y)
    if (under && svg.contains(under)) track(c.x, c.y)
    else if (lastClient || hovered.value) onLeave()
  }, { flush: 'post' })
}

function onLeave() {
  lastClient = null
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
  for (const p of drawnParts.value)
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

const TIP_GAP = 14
const TIP_PAD = 4
/** The tooltip's place: below right of the cursor, clamped inside the box (above the cursor when there is no room below). */
const tipStyle = computed(() => {
  const t = tipAt.value
  if (!t) return {}
  const { w, h } = tipSize.value
  const clamp = (v: number, max: number) => Math.max(TIP_PAD, Math.min(max, v))
  const left = clamp(t.x + TIP_GAP, t.w - w - TIP_PAD)
  const below = t.y + TIP_GAP
  const top = clamp(below + h + TIP_PAD <= t.h ? below : t.y - TIP_GAP - h, t.h - h - TIP_PAD)
  return { left: `${left}px`, top: `${top}px` }
})
watch([tip, tipAt], () => {
  const el = tipEl.value
  if (el && (el.offsetWidth !== tipSize.value.w || el.offsetHeight !== tipSize.value.h))
    tipSize.value = { w: el.offsetWidth, h: el.offsetHeight }
}, { flush: 'post' })

/** Navigate shows the canvas's grab cursor; inspect an arrow; the edit tools a crosshair. */
const cursorClass = computed(() => {
  if (props.tool === 'navigate') return ''
  return props.tool === 'inspect' ? 'cursor-default' : 'cursor-crosshair'
})

const ringed = computed(() => {
  const h = hovered.value ?? props.hoverHole
  return h ? geo.value.pt(h) : null
})
</script>

<template>
  <div
    ref="rootEl"
    class="relative size-full"
  >
    <div class="size-full">
      <svg
        ref="svgEl"
        :viewBox="viewBox"
        class="block size-full select-none"
        :class="cursorClass"
        font-family="'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace"
        role="img"
        :aria-label="`Board ${side} side${MIRROR_LABEL[mirror]}`"
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
        <!-- the other side's wires, dashed, under everything of this side -->
        <BoardGhostWires
          v-if="layers.wires"
          :board="drawn"
          :side="side"
          :geo="geo"
        />
        <BoardCopper
          v-if="layers.trails"
          :board="drawn"
          :side="side"
          :geo="geo"
          :lit="lit"
          :conn="connectivity"
          :placed="drawnParts"
        />
        <BoardParts
          v-if="layers.components"
          :board="drawn"
          :side="side"
          :geo="geo"
          :lit="lit"
          :placed="drawnParts"
        />
        <BoardWires
          v-if="layers.wires"
          :board="drawn"
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

    <Teleport
      :to="canvas?.overlay.value ?? 'body'"
      :disabled="!canvas?.overlay.value"
    >
      <div
        v-if="tip && tipAt"
        ref="tipEl"
        class="pointer-events-none absolute z-10 w-max rounded-md border border-default bg-default px-2 py-1 font-mono text-xs whitespace-nowrap shadow-md"
        :style="tipStyle"
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
    </Teleport>
  </div>
</template>
