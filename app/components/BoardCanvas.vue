<script setup lang="ts">
// The 2D canvas: both board sides as frames on one plane, like a Miro board. Wheel or
// pinch zooms about the cursor; a drag pans (left drag past 4 px, any left drag with the
// Navigate tool, right or middle drag, Space + drag over the canvas, one finger); a press
// that does not move is a click for the board under it. The gesture rules are the pure
// `gestureStep`; this component feeds it pointer events and applies what it returns.
//
// Crisp at every zoom: the frames are laid out in px (world mm x scale), so the SVGs are
// drawn at their real size; the layer only translates by whole px. No bitmap is scaled.
//
// The view is stored per board as the board point at the canvas centre and the zoom
// relative to "fit both", so it fits any window; nothing is stored until the user moves it.
import type { Side } from '~core/schema'
import type { Tool } from '~/utils/boardView'
import {
  clampPan, DRAG_PX, easeView, fitRect, fromStored, gestureStep, IDLE, keepCentre, loadView, panBy, saveView,
  toStored, unionRect, ZOOM_STEP, zoomAt, zoomLimits, type Camera, type GestureEvent, type GestureState, type Point,
  type Rect, type Size
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
const size = shallowRef<Size>({ w: 0, h: 0 })
/** False until the stored or fitted view is in place: nothing is drawn before, so no flash. */
const ready = ref(false)
const panning = ref(false)
/** The pointer over the canvas, client px (not reactive: read when the camera moves). */
const pointer: { value: Point | null } = { value: null }

provide(CANVAS_CONTEXT, { overlay: root, camera, panning, pointer })

const all = computed(() => unionRect(props.frames.map(f => f.rect)))
const fitScale = computed(() => fitRect(all.value, size.value, FIT_MARGIN).scale)
const limits = computed(() => zoomLimits(fitScale.value))

watch([camera, fitScale], ([c, f]) => {
  if (ready.value) emit('zoom', Math.round((c.scale / f) * 100))
})

/** Set by the user's own moves (wheel, drag, pinch, zoom buttons, framing); until then nothing is stored. */
let moved = false

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

/** Frames both sides, or one, filling the canvas with a margin (the user's choice: it is stored). */
function frame(which: 'both' | Side, animate = true) {
  moved = true
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
  moved = true
  camera.value = zoomAt(camera.value, centre(), dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, limits.value)
}

defineExpose({ frame, zoomStep })

// ---- Size, the stored view, saving -------------------------------------------------------
const storage = () => window.localStorage

/** A resize (window, side panel) keeps the board point at the centre where it is. */
function measure() {
  const el = root.value
  if (!el) return
  const next = { w: el.clientWidth, h: el.clientHeight }
  const prev = size.value
  if (next.w === prev.w && next.h === prev.h) return
  size.value = next
  if (ready.value) camera.value = keepCentre(camera.value, prev, next)
}

/** The stored view in this canvas, else both sides fitted. */
function restore() {
  const v = loadView(props.persistKey, storage)
  camera.value = v ? fromStored(v, size.value, fitScale.value) : fitRect(all.value, size.value, FIT_MARGIN)
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function saveNow(key = props.persistKey) {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (ready.value && moved) saveView(key, toStored(camera.value, size.value, fitScale.value), storage)
}
watch(camera, () => {
  if (!ready.value || !moved) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, SAVE_MS)
})
watch(() => props.persistKey, (k, old) => {
  if (old !== undefined && saveTimer) saveNow(old)
  moved = false
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
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  if (saveTimer) saveNow()
  stopAnim()
  ro?.disconnect()
  root.value?.removeEventListener('wheel', onWheel)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onBlur)
  document.removeEventListener('visibilitychange', onVisibility)
  cancelGesture()
})

// ---- Wheel and trackpad pinch -------------------------------------------------------------
function local(p: Point): Point {
  const r = root.value!.getBoundingClientRect()
  return { x: p.x - r.left, y: p.y - r.top }
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  stopAnim()
  moved = true
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.value.h : 1
  // A trackpad pinch arrives as a wheel with ctrlKey and small deltas: a stronger rate.
  const rate = e.ctrlKey ? 0.01 : 0.0015
  camera.value = zoomAt(camera.value, local({ x: e.clientX, y: e.clientY }), Math.exp(-e.deltaY * unit * rate), limits.value)
}

// ---- Pointer: click, drag-pan, pinch --------------------------------------------------------
let gesture: GestureState = IDLE
const spaceDown = ref(false)
/** Space pans only while the pointer is over the canvas. */
let overCanvas = false

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

/** Captures the pointers once a press is a pan, so its moves and release come here even off the window. */
function capture() {
  for (const [id] of gesture.pts) {
    try {
      if (!root.value?.hasPointerCapture(id)) root.value?.setPointerCapture(id)
    } catch { /* the pointer is already gone */ }
  }
}

/** Drops the gesture: no pointers, no pan (a lost release, the window losing focus). */
function cancelGesture() {
  for (const [id] of gesture.pts) {
    try {
      root.value?.releasePointerCapture(id)
    } catch { /* not captured */ }
  }
  gesture = gestureStep(gesture, { type: 'cancel' }).state
  panning.value = false
  detach()
}

function step(e: GestureEvent) {
  const wasIdle = gesture.mode === 'idle'
  const r = gestureStep(gesture, e)
  gesture = r.state
  if (r.cancelled) return cancelGesture()
  if (r.pan || r.zoom) {
    stopAnim()
    moved = true
    let c = camera.value
    if (r.pan) c = clampPan(panBy(c, r.pan.dx, r.pan.dy), all.value, size.value)
    if (r.zoom) c = zoomAt(c, local(r.zoom.at), r.zoom.factor, limits.value)
    camera.value = c
  }
  const nowPanning = gesture.mode === 'pan' || gesture.mode === 'pinch'
  // Capture only once it is a pan: a click keeps its target (the board under it).
  if (nowPanning && !panning.value) capture()
  panning.value = nowPanning
  if (wasIdle && gesture.mode !== 'idle') attach()
  if (gesture.mode === 'idle') detach()
}

function onDown(e: PointerEvent) {
  stopAnim()
  // No middle-button autoscroll.
  if (e.button === 1) e.preventDefault()
  step({
    type: 'down', id: e.pointerId, p: { x: e.clientX, y: e.clientY }, button: e.button, pointerType: e.pointerType,
    panNow: e.button === 1 || e.button === 2 || spaceDown.value, threshold: props.tool === 'navigate' ? 0 : DRAG_PX
  })
}
function onMove(e: PointerEvent) {
  step({ type: 'move', id: e.pointerId, p: { x: e.clientX, y: e.clientY }, buttons: e.buttons, pointerType: e.pointerType })
}
function onUp(e: PointerEvent) {
  step({ type: 'up', id: e.pointerId })
}

/** After a drag, the click the browser sends is not a click on the board. */
function onClickCapture(e: MouseEvent) {
  if (!gesture.swallowClick) return
  gesture = { ...gesture, swallowClick: false }
  e.stopPropagation()
  e.preventDefault()
}

function onEnter(e: PointerEvent) {
  overCanvas = true
  pointer.value = { x: e.clientX, y: e.clientY }
}
function onHere(e: PointerEvent) {
  pointer.value = { x: e.clientX, y: e.clientY }
}
function onOut() {
  overCanvas = false
  if (!panning.value) pointer.value = null
}

// ---- Space + drag (over the canvas only) ---------------------------------------------------
/** Space on these keeps its own meaning (press a button, toggle a switch, pick a tab). */
const SPACE_KEEPERS = 'button, a, summary, [role="button"], [role="switch"], [role="tab"], [tabindex]'

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== ' ') return
  if (e.repeat) {
    if (spaceDown.value) e.preventDefault()
    return
  }
  const t = e.target as Element | null
  if (!overCanvas || isTyping(t) || t?.matches?.(SPACE_KEEPERS)) return
  e.preventDefault()
  spaceDown.value = true
}
function onKeyUp(e: KeyboardEvent) {
  if (e.key === ' ') spaceDown.value = false
}
function onBlur() {
  spaceDown.value = false
  cancelGesture()
}
function onVisibility() {
  if (document.hidden) onBlur()
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
    @pointerenter="onEnter"
    @pointermove="onHere"
    @pointerleave="onOut"
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
