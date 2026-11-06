<!-- eslint-disable vue/multi-word-component-names -- the plan names it Toolbar -->
<script setup lang="ts">
// The view row: 2D or 3D, zoom and mirror. What the 2D canvas frames (both sides, top,
// bottom) is picked on the canvas itself, as the 3D camera presets are; the keys and the
// drawing hint are under the canvas. The editing tools and undo/redo are in the Edit tab.
import { lockedAttrs, type View } from '~/utils/boardView'
import { ZOOM_MAX, ZOOM_MIN } from '~/utils/camera2d'

const props = defineProps<{
  /** What the canvas shows: a 2D framing or the 3D view. */
  view: View
  /** The canvas zoom in percent of "fit both sides". */
  zoom: number
}>()
const emit = defineEmits<{ 'mode': [mode: '2d' | '3d'], 'zoom-in': [], 'zoom-out': [], 'fit': [] }>()
const mirrorBottom = defineModel<boolean>('mirrorBottom', { required: true })

/** The 3D view is read-only: mirror and zoom are off there. */
const locked = computed(() => props.view === '3d')
</script>

<template>
  <div class="flex flex-wrap items-center gap-4 border-b border-default px-4 py-2 text-sm">
    <div
      class="flex gap-1"
      role="group"
      aria-label="View"
    >
      <UButton
        size="xs"
        :variant="locked ? 'outline' : 'solid'"
        label="2D"
        title="2D view, for editing (3)"
        :aria-pressed="!locked"
        @click="emit('mode', '2d')"
      />
      <UButton
        size="xs"
        :variant="locked ? 'solid' : 'outline'"
        label="3D"
        title="3D view, for looking (3)"
        :aria-pressed="locked"
        @click="emit('mode', '3d')"
      />
    </div>
    <div
      class="flex items-center gap-1"
      role="group"
      aria-label="Zoom"
    >
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-zoom-out"
        aria-label="Zoom out"
        :title="lockedAttrs(locked, 'Zoom out (-)').title"
        :disabled="locked || zoom <= ZOOM_MIN * 100"
        @click="emit('zoom-out')"
      />
      <UButton
        size="xs"
        variant="ghost"
        class="w-12 justify-center font-mono"
        :label="`${zoom}%`"
        v-bind="lockedAttrs(locked, 'Fit both sides (0)')"
        @click="emit('fit')"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-zoom-in"
        aria-label="Zoom in"
        :title="lockedAttrs(locked, 'Zoom in (+)').title"
        :disabled="locked || zoom >= ZOOM_MAX * 100"
        @click="emit('zoom-in')"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-scan"
        label="Fit"
        v-bind="lockedAttrs(locked, 'Fit both sides (0)')"
        @click="emit('fit')"
      />
    </div>
    <USwitch
      v-model="mirrorBottom"
      label="Mirror bottom"
      v-bind="lockedAttrs(locked)"
    />
  </div>
</template>
