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
import { buildScene } from '~core/scene3d'
import { CAMERA_FOV, cameraPreset, type CameraPresetName } from '~/utils/cameraPresets'
import { buildMeshes, webglAvailable, type BuiltMeshes } from '~/utils/scene3dThree'

const props = defineProps<{ board: BoardFile }>()
const emit = defineEmits<{ back: [] }>()

// Dev only: `?nowebgl` pretends the browser has WebGL turned off, to see the fallback.
if (import.meta.dev && new URLSearchParams(window.location.search).has('nowebgl'))
  HTMLCanvasElement.prototype.getContext = () => null
const hasWebgl = webglAvailable()

const scene = computed(() => buildScene(props.board))
/** Stable parent of the board meshes; its child is swapped on every rebuild. */
const content = new THREE.Group()
let built: BuiltMeshes | null = null
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
  const old = built
  built = buildMeshes(scene.value)
  content.add(built.group)
  if (old) {
    content.remove(old.group)
    old.dispose()
  }
  rebuilds++
  invalidate()
}
watch(scene, rebuild)
if (hasWebgl) rebuild()

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
  invalidate()
}

function onReady(c: TresContext) {
  ctx = c
  // The controls mount with the canvas; wait a tick so their instance exists.
  nextTick(() => applyPreset('iso'))
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
      preset: applyPreset
    }
  }
}

onBeforeUnmount(() => {
  built?.dispose()
  built = null
  content.clear()
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
  <div
    v-if="!hasWebgl"
    class="mx-auto max-w-xl"
  >
    <UAlert
      color="warning"
      variant="subtle"
      icon="i-lucide-box"
      title="3D view needs WebGL, which this browser has turned off."
    >
      <template #actions>
        <UButton
          size="xs"
          color="warning"
          label="Both sides"
          @click="emit('back')"
        />
      </template>
    </UAlert>
  </div>
  <div
    v-else
    class="flex flex-col gap-1"
  >
    <div
      ref="wrap"
      class="relative h-[70vh] min-h-80 overflow-hidden rounded-md border border-default"
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
      </TresCanvas>
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
