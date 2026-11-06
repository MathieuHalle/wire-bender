<script setup lang="ts">
// The 3D view: the board as built, for looking only (no edit tools). Loaded lazily, so
// three.js and TresJS stay out of the 2D page's bundle.
//
// The camera and the controls live as long as this component. When the board changes,
// only the meshes under `content` are swapped and the old ones disposed, so the view
// stays where the user left it.
import { TresCanvas, type TresContext } from '@tresjs/core'
import { OrbitControls } from '@tresjs/cientos'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js'
import type { BoardFile } from '~core/schema'
import { holeMm, type Hole } from '~core/holes'
import { buildScene, type Tag } from '~core/scene3d'
import { fallbackAlert, type Board3DFailure } from '~/utils/board3dFallback'
import { ALL_LAYERS, visibleTag, type Layers } from '~/utils/layers'
import { CAMERA_FOV, cameraPreset, type CameraPresetName } from '~/utils/cameraPresets'
import {
  buildMeshes, dispose, markRings, markVisibility, primMeshes, setHighlight, tagTip, webglAvailable, type BuiltMeshes
} from '~/utils/scene3dThree'

const props = withDefaults(defineProps<{
  board: BoardFile
  /** Nets to keep bright; every other mesh is dimmed. Empty: nothing dimmed. */
  highlightNets?: string[]
  /** Holes of the finding picked in the panel, ringed on both surfaces. */
  markHoles?: Hole[]
  /** The Edit tab's view layers: hidden prims are not drawn and not hovered. */
  layers?: Layers
}>(), { highlightNets: () => [], markHoles: () => [], layers: () => ({ ...ALL_LAYERS }) })
const emit = defineEmits<{ 'back': [], 'hover-tag': [tag: Tag | null] }>()

// Dev only, to see the fallbacks: `?nowebgl` pretends the browser has WebGL turned off;
// `?failrenderer` lets the probe pass, then makes the WebGL renderer's constructor throw;
// `?fail3d` throws once mounted, which the page's error boundary catches.
const devFlags = import.meta.dev ? new URLSearchParams(window.location.search) : null
if (devFlags?.has('nowebgl')) HTMLCanvasElement.prototype.getContext = () => null
if (devFlags?.has('fail3d')) {
  onMounted(() => {
    throw new Error('fail3d: the 3D view failed on purpose (dev flag)')
  })
}
const hasWebgl = webglAvailable()
if (devFlags?.has('failrenderer')) {
  HTMLCanvasElement.prototype.getContext = () => {
    throw new Error('failrenderer: no WebGL context for the renderer (dev flag)')
  }
}

/** Set when the view cannot draw: WebGL is off, or the renderer (or another child) threw. */
const failed = shallowRef<Board3DFailure | null>(hasWebgl ? null : { kind: 'no-webgl' })
onErrorCaptured((error) => {
  console.error('3D view failed:', error)
  failed.value = { kind: 'error', error }
  return false
})

const scene = computed(() => buildScene(props.board))
/** Stable parent of the board meshes; its child is swapped on every rebuild. */
const content = new THREE.Group()
/** Stable parent of the finding marks, rebuilt on their own (the board meshes stay). */
const marks = new THREE.Group()
let built: BuiltMeshes | null = null
/** The prim meshes of `built`: what hover and highlight work on. */
let prims: THREE.Mesh[] = []
/** What the hover raycast tests, per build: the slab (it hides what is behind it), then the prims. */
let pickable: THREE.Object3D[] = []
let rebuilds = 0

const wrap = ref<HTMLElement | null>(null)
// Plain three objects handed to TresJS (its typed <TresPerspectiveCamera> and light
// elements don't typecheck under vue-tsc 3 here; see the task report).
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 5000)
/** One ambient light and two directional ones, above and below, so the solder side is lit. */
const lights = new THREE.Group()
const sun = new THREE.DirectionalLight('#ffffff', 1.8)
sun.position.set(40, 120, 70)
const under = new THREE.DirectionalLight('#ffffff', 1.1)
under.position.set(-30, -120, -50)
lights.add(new THREE.AmbientLight('#ffffff', 0.55), sun, under)
const controls = shallowRef<{ instance: OrbitControlsImpl | null } | null>(null)
let ctx: TresContext | null = null

const invalidate = () => ctx?.renderer.invalidate()

function rebuild() {
  if (!hasWebgl) return
  const old = built
  built = buildMeshes(scene.value)
  content.add(built.group)
  if (old) {
    content.remove(old.group)
    old.dispose()
  }
  prims = primMeshes(built.group)
  applyLayers()
  setHighlight(prims, props.highlightNets)
  rebuilds++
  invalidate()
}
watch(scene, rebuild)

/**
 * Shows or hides each prim by its tag under the layers (the scene is not rebuilt), and
 * keeps only the shown ones pickable, so the hover never lands on a hidden mesh.
 */
function applyLayers() {
  if (!built) return
  for (const m of prims) m.visible = visibleTag(m.userData.tag as Tag | undefined, props.layers)
  const slab = built.group.getObjectByName('board')
  const shown = prims.filter(m => m.visible)
  pickable = slab ? [slab, ...shown] : shown
}
rebuild()
watch(() => props.layers, () => {
  applyLayers()
  // The hovered mesh may have just been hidden.
  if (hovered.value && !visibleTag(hovered.value, props.layers)) {
    tipAt.value = null
    setHovered(null)
  }
  invalidate()
}, { deep: true })

watch(() => props.highlightNets, (nets) => {
  setHighlight(prims, nets)
  invalidate()
})

function rebuildMarks() {
  if (!hasWebgl) return
  const old = marks.children.slice()
  const pitch = props.board.board.pitchMm
  marks.add(markRings(scene.value, props.markHoles.map((h) => {
    const m = holeMm(h, pitch)
    return { x: m.x, z: m.y }
  })))
  for (const o of old) {
    marks.remove(o)
    dispose(o)
  }
  markVisibility(marks, scene.value, camera)
  invalidate()
}
watch([() => props.markHoles, scene], rebuildMarks)
rebuildMarks()

// ---- Hover: one raycast per animation frame -------------------------------------
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
/** The last pointer position seen; cast at the next frame. */
let pending: { x: number, y: number, buttons: number } | null = null
let frame = 0
const hovered = shallowRef<Tag | null>(null)
const tipAt = ref<{ x: number, y: number, flip: boolean } | null>(null)
const tip = computed(() => (hovered.value ? tagTip(hovered.value, props.board) : null))

function setHovered(tag: Tag | null) {
  if (tag === hovered.value) return
  hovered.value = tag
  emit('hover-tag', tag)
}

/** The tagged mesh under the pointer; the slab hides what is behind it. */
function castAt(x: number, y: number): Tag | null {
  const el = ctx?.renderer.instance.domElement
  if (!el || !built) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1)
  camera.updateMatrixWorld()
  raycaster.setFromCamera(ndc, camera)
  const hit = raycaster.intersectObjects(pickable, false)[0]
  const tag = hit?.object.userData.tag as Tag | undefined
  return tag && tag.kind !== 'board' ? tag : null
}

function onFrame() {
  frame = 0
  const p = pending
  pending = null
  // Dragging orbits the camera: leave the hover as it is until the buttons are up.
  if (!p || p.buttons) return
  const tag = castAt(p.x, p.y)
  setHovered(tag)
  const w = wrap.value?.getBoundingClientRect()
  tipAt.value = tag && w
    ? { x: p.x - w.left, y: p.y - w.top, flip: p.x - w.left > w.width * 0.6 }
    : null
}

function onPointer(ev: PointerEvent) {
  pending = { x: ev.clientX, y: ev.clientY, buttons: ev.buttons }
  if (!frame) frame = requestAnimationFrame(onFrame)
}

/** A drag-orbit may start: hide the tooltip, which would otherwise stay where it was. */
function onDown() {
  tipAt.value = null
}

/** The rings show only on the side the camera is on, since they are drawn over everything. */
function onCameraChange() {
  markVisibility(marks, scene.value, camera)
  invalidate()
}

function onLeave() {
  pending = null
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  tipAt.value = null
  setHovered(null)
}

function applyPreset(which: CameraPresetName) {
  const cam = camera
  const ctl = controls.value?.instance
  if (!ctl) return
  const el = wrap.value
  const aspect = el && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : cam.aspect
  const p = cameraPreset(scene.value, which, aspect)
  cam.up.set(...p.up)
  cam.position.set(...p.position)
  ctl.target.set(...p.target)
  ctl.update()
  onCameraChange()
}

function onReady(c: TresContext) {
  ctx = c
  // The controls mount with the canvas; wait a tick so their instance exists.
  nextTick(() => {
    controls.value?.instance?.addEventListener('change', onCameraChange)
    applyPreset('iso')
  })
  if (import.meta.dev) {
    (window as unknown as { __wb3d?: unknown }).__wb3d = {
      get info() {
        return (c.renderer.instance as THREE.WebGLRenderer).info
      },
      get rebuilds() {
        return rebuilds
      },
      camera,
      controls: () => controls.value?.instance,
      rebuild,
      preset: applyPreset,
      get hovered() {
        return hovered.value
      },
      get dimmed() {
        return prims.filter(m => (m.material as THREE.Material).transparent).length
      },
      get prims() {
        return prims.length
      },
      get shown() {
        return prims.filter(m => m.visible).length
      },
      get pickable() {
        return pickable.length
      },
      get marks() {
        const side = (n: string) => {
          const m = marks.getObjectByName(n) as THREE.InstancedMesh | undefined
          return m ? { count: m.count, visible: m.visible } : null
        }
        return { top: side('marks-top'), bottom: side('marks-bottom') }
      }
    }
  }
}

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  if (hovered.value) emit('hover-tag', null)
  built?.dispose()
  built = null
  prims = []
  pickable = []
  controls.value?.instance?.removeEventListener('change', onCameraChange)
  content.clear()
  dispose(marks)
  sun.dispose()
  under.dispose()
  if (import.meta.dev) delete (window as unknown as { __wb3d?: unknown }).__wb3d
})

const PRESETS: { id: CameraPresetName, label: string }[] = [
  { id: 'iso', label: 'Iso' },
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' }
]
</script>

<template>
  <Board3DFallback
    v-if="failed"
    v-bind="fallbackAlert(failed)"
    @back="emit('back')"
  />
  <div
    v-else
    class="flex min-h-0 flex-col gap-1"
  >
    <div
      ref="wrap"
      class="relative min-h-0 flex-1 overflow-hidden rounded-md border border-default"
      @pointermove="onPointer"
      @pointerup="onPointer"
      @pointerdown="onDown"
      @pointerleave="onLeave"
    >
      <TresCanvas
        :camera="camera"
        clear-color="#2b2f35"
        render-mode="on-demand"
        @ready="onReady"
      >
        <!-- No damping: with on-demand rendering a leftover glide would play out on the
             next rebuild and move the camera the user left. -->
        <OrbitControls
          ref="controls"
          make-default
          :enable-damping="false"
        />
        <primitive :object="lights" />
        <primitive :object="content" />
        <primitive :object="marks" />
      </TresCanvas>
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
          v-for="l in tip.lines"
          :key="l"
        >
          {{ l }}
        </div>
        <div
          v-if="tip.net"
          class="text-muted"
        >
          {{ tip.net }}
        </div>
      </div>
      <div
        class="absolute top-2 left-2 flex gap-1"
        role="group"
        aria-label="Camera"
      >
        <UButton
          v-for="p in PRESETS"
          :key="p.id"
          size="xs"
          color="neutral"
          variant="solid"
          :label="p.label"
          @click="applyPreset(p.id)"
        />
      </div>
    </div>
    <p class="text-xs text-muted">
      Drag to orbit, right-drag to pan, scroll to zoom.
    </p>
    <ul
      v-if="scene.skipped.length"
      class="font-mono text-xs text-muted"
    >
      <li
        v-for="s in scene.skipped"
        :key="s"
      >
        not drawn: {{ s }}
      </li>
    </ul>
  </div>
</template>
