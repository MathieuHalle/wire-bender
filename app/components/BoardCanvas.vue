<script setup lang="ts">
// The 2D canvas: both board sides as frames on one plane, like a Miro board. Wheel or
// pinch zooms about the cursor; a drag pans (left drag past 4 px, any left drag with the
// Navigate tool, right or middle drag, Space + drag, one finger); a press that does not
// move is a click for the board under it. The camera is stored per board.
//
// Crisp at every zoom: the frames are laid out in px (world mm x scale), so the SVGs are
// drawn at their real size; the layer only translates by whole px. No bitmap is scaled.
import type { Side } from '~core/schema'
import type { Tool } from '~/utils/boardView'
import {
  DRAG_PX, easeView, fitRect, isDrag, loadView, panBy, saveView, unionRect, ZOOM_STEP, zoomAt, zoomLimits,
  type Camera, type Point, type Rect
} from '~/utils/camera2d'
import { CANVAS_CONTEXT } from '~/utils/canvasContext'
import { isTyping } from '~/composables/useTools'

export interface CanvasFrame { id: Side, title: string, rect: Rect }

const props = defineProps<{
  frames: CanvasFrame[]
  /** The stored view's name (the board's name). */
  persistKey: string
  tool: Tool
}>()

const emit = defineEmits<{
  /** The zoom in percent of "fit both sides", rounded. */
  zoom: [percent: number]
}>()

/** Room (px) around a framed rect; the frame titles sit in it. */
const FIT_MARGIN = 40
const ANIM_MS = 250
const SAVE_MS = 300

const root = ref<HTMLDivElement | null>(null)
const camera = shallowRef<Camera>({ x: 0, y: 0, scale: 1 })
const size = shallowRef({ w: 0, h: 0 })
/** False until the stored or fitted view is in place: nothing is drawn before, so no flash. */
const ready = ref(false)

provide(CANVAS_CONTEXT, { overlay: root, camera })

const all = computed(() => unionRect(props.frames.map(f => f.rect)))
const fitScale = computed(() => fitRect(all.value, size.value, FIT_MARGIN).scale)
const limits = computed(() => zoomLimits(fitScale.value))

watch([camera, fitScale], ([c, f]) => {
  if (ready.value) emit('zoom', Math.round((c.scale / f) * 100))
})

// ---- Framing and the animation -------------------------------------------------------
let anim = 0
function stopAnim() {
  if (anim) cancelAnimationFrame(anim)
  anim = 0
}
function animateTo(to: Camera) {
  stopAnim()
  const from = camera.value
  const t0 = performance.now()
  const step = (now: number) => {
    const t = (now - t0) / ANIM_MS
    camera.value = easeView(from, to, t)
    anim = t < 1 ? requestAnimationFrame(step) : 0
  }
  anim = requestAnimationFrame(step)
}

function target(which: 'both' | Side): Rect {
  return which === 'both' ? all.value : props.frames.find(f => f.id === which)?.rect ?? all.value
}

/** Frames both sides, or one, filling the canvas with a margin. */
function frame(which: 'both' | Side, animate = true) {
  const to = fitRect(target(which), size.value, FIT_MARGIN)
  if (animate) animateTo(to)
  else {
    stopAnim()
    camera.value = to
  }
}

function centre(): Point {
  return { x: size.value.w / 2, y: size.value.h / 2 }
}

/** One ×1.25 step in (1) or out (-1), about the canvas centre. */
function zoomStep(dir: 1 | -1) {
  stopAnim()
  camera.value = zoomAt(camera.value, centre(), dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, limits.value)
}

defineExpose({ frame, zoomStep })

// ---- Size, the stored view, saving -------------------------------------------------------
const storage = () => window.localStorage

function measure() {
  const el = root.value
  if (el) size.value = { w: el.clientWidth, h: el.clientHeight }
}

/** The stored view (its scale kept within the limits), else both sides fitted. */
function restore() {
  const v = loadView(props.persistKey, storage)
  if (!v) return frame('both', false)
  const s = Math.min(limits.value.max, Math.max(limits.value.min, v.scale))
  camera.value = s === v.scale ? v : zoomAt(v, centre(), s / v.scale, limits.value)
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function saveNow() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (ready.value) saveView(props.persistKey, camera.value, storage)
}
watch(camera, () => {
  if (!ready.value) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, SAVE_MS)
})
watch(() => props.persistKey, (k, old) => {
  if (old !== undefined && saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = undefined
    saveView(old, camera.value, storage)
  }
  if (ready.value) restore()
})

let ro: ResizeObserver | undefined
onMounted(() => {
  measure()
  restore()
  ready.value = true
  emit('zoom', Math.round((camera.value.scale / fitScale.value) * 100))
  ro = new ResizeObserver(measure)
  if (root.value) ro.observe(root.value)
  root.value?.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
})
onBeforeUnmount(() => {
  if (saveTimer) saveNow()
  stopAnim()
  ro?.disconnect()
  root.value?.removeEventListener('wheel', onWheel)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onBlur)
  detach()
})

// ---- Wheel and trackpad pinch -------------------------------------------------------------
function local(cx: number, cy: number): Point {
  const r = root.value!.getBoundingClientRect()
  return { x: cx - r.left, y: cy - r.top }
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  stopAnim()
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.value.h : 1
  // A trackpad pinch arrives as a wheel with ctrlKey and small deltas: a stronger rate.
  const rate = e.ctrlKey ? 0.01 : 0.0015
  camera.value = zoomAt(camera.value, local(e.clientX, e.clientY), Math.exp(-e.deltaY * unit * rate), limits.value)
}

// ---- Pointer: click, drag-pan, pinch --------------------------------------------------------
/** Pointers down, in client px. */
const pointers = new Map<number, Point>()
type Gesture
  = | { mode: 'pending' | 'pan', start: Point, last: Point, threshold: number }
    | { mode: 'pinch', mid: Point, dist: number }
let gesture: Gesture | null = null
/** Set when a press became a pan or pinch: the click that follows is swallowed. */
let swallowClick = false
const panning = ref(false)
const spaceDown = ref(false)

function attach() {
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
function detach() {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)
}

function pinchOf(): { mid: Point, dist: number } {
  const [a, b] = [...pointers.values()] as [Point, Point]
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) }
}

function startPan() {
  panning.value = true
  swallowClick = true
}

function onDown(e: PointerEvent) {
  stopAnim()
  if (e.pointerType === 'mouse' && e.button > 2) return
  // No middle-button autoscroll.
  if (e.button === 1) e.preventDefault()
  const p = { x: e.clientX, y: e.clientY }
  if (pointers.size === 0) {
    swallowClick = false
    attach()
  }
  pointers.set(e.pointerId, p)
  if (pointers.size === 1) {
    const now = e.button === 1 || e.button === 2 || spaceDown.value
    gesture = { mode: now ? 'pan' : 'pending', start: p, last: p, threshold: props.tool === 'navigate' ? 0 : DRAG_PX }
    if (now) startPan()
  } else if (pointers.size === 2) {
    gesture = { mode: 'pinch', ...pinchOf() }
    startPan()
  }
}

function onMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId) || !gesture) return
  const p = { x: e.clientX, y: e.clientY }
  pointers.set(e.pointerId, p)
  if (gesture.mode === 'pinch') {
    if (pointers.size < 2) return
    const n = pinchOf()
    const moved = panBy(camera.value, n.mid.x - gesture.mid.x, n.mid.y - gesture.mid.y)
    camera.value = zoomAt(moved, local(n.mid.x, n.mid.y), n.dist / gesture.dist, limits.value)
    gesture = { mode: 'pinch', ...n }
    return
  }
  if (gesture.mode === 'pending') {
    if (!isDrag(p.x - gesture.start.x, p.y - gesture.start.y, gesture.threshold)) return
    gesture.mode = 'pan'
    startPan()
  }
  camera.value = panBy(camera.value, p.x - gesture.last.x, p.y - gesture.last.y)
  gesture.last = p
}

function onUp(e: PointerEvent) {
  if (!pointers.delete(e.pointerId)) return
  if (pointers.size === 1 && gesture?.mode === 'pinch') {
    // Lifting one finger of a pinch carries on as a pan with the other.
    const rest = [...pointers.values()][0]!
    gesture = { mode: 'pan', start: rest, last: rest, threshold: 0 }
    return
  }
  if (pointers.size > 0) return
  gesture = null
  panning.value = false
  detach()
}

/** After a drag, the click the browser sends is not a click on the board. */
function onClickCapture(e: MouseEvent) {
  if (!swallowClick) return
  swallowClick = false
  e.stopPropagation()
  e.preventDefault()
}

// ---- Space + drag --------------------------------------------------------------------------
function onKeyDown(e: KeyboardEvent) {
  if (e.key !== ' ' || isTyping(e.target)) return
  e.preventDefault()
  spaceDown.value = true
}
function onKeyUp(e: KeyboardEvent) {
  if (e.key === ' ') spaceDown.value = false
}
function onBlur() {
  spaceDown.value = false
}

/** While panning (or Space is held), the board's own crosshair gives way to the hand (the class on the root). */
const cursor = computed(() => {
  if (panning.value) return 'grabbing'
  if (spaceDown.value || props.tool === 'navigate') return 'grab'
  return undefined
})

// ---- Layout (px) ---------------------------------------------------------------------------
const layerStyle = computed(() => {
  const c = camera.value
  return { transform: `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px)` }
})
const frameStyle = (r: Rect) => {
  const s = camera.value.scale
  return { left: `${r.x * s}px`, top: `${r.y * s}px`, width: `${r.w * s}px`, height: `${r.h * s}px` }
}
</script>

<template>
  <div
    ref="root"
    class="relative touch-none overflow-hidden rounded-md border border-default bg-muted select-none"
    :class="{ '[&_*]:cursor-[inherit]!': panning || spaceDown }"
    :style="{ cursor }"
    role="region"
    aria-label="Board canvas: scroll to zoom, drag to pan"
    @pointerdown="onDown"
    @click.capture="onClickCapture"
    @contextmenu.prevent
  >
    <div
      v-if="ready"
      class="absolute top-0 left-0 will-change-transform"
      :style="layerStyle"
    >
      <section
        v-for="f in frames"
        :key="f.id"
        class="absolute"
        :style="frameStyle(f.rect)"
      >
        <h2
          class="absolute bottom-full left-0 mb-1 max-w-full truncate text-sm font-medium text-muted"
          :title="f.title"
        >
          {{ f.title }}
        </h2>
        <div class="size-full rounded-sm bg-default shadow-sm">
          <slot
            name="frame"
            :frame="f"
          />
        </div>
      </section>
    </div>
  </div>
</template>
