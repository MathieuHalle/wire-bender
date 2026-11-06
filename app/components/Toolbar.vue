<!-- eslint-disable vue/multi-word-component-names -- the plan names it Toolbar -->
<script setup lang="ts">
// The view row: what to frame (or 3D), zoom, mirror, the keys, and the drawing hint. The
// editing tools and undo/redo are in the side panel's Edit tab.
import { lockedAttrs, type View } from '~/utils/boardView'
import { ZOOM_MAX, ZOOM_MIN } from '~/utils/camera2d'

defineProps<{
  /** Shown near the board, e.g. "Drawing T7 on bottom", so it stays in view with the panel collapsed. */
  hint?: string | null
  /** The canvas zoom in percent of "fit both sides". */
  zoom: number
}>()
const emit = defineEmits<{ 'zoom-in': [], 'zoom-out': [], 'fit': [] }>()

const view = defineModel<View>('view', { required: true })
const mirrorBottom = defineModel<boolean>('mirrorBottom', { required: true })

/** The 3D view is read-only: mirror and zoom are off there. */
const locked = computed(() => view.value === '3d')
</script>

<template>
  <div class="flex flex-wrap items-center gap-4 border-b border-default px-4 py-2 text-sm">
    <div class="flex gap-1">
      <UButton
        size="xs"
        :variant="view === 'both' ? 'solid' : 'outline'"
        label="Both sides"
        @click="view = 'both'"
      />
      <UButton
        size="xs"
        :variant="view === 'top' ? 'solid' : 'outline'"
        label="Top"
        @click="view = 'top'"
      />
      <UButton
        size="xs"
        :variant="view === 'bottom' ? 'solid' : 'outline'"
        label="Bottom"
        @click="view = 'bottom'"
      />
      <UButton
        size="xs"
        :variant="view === '3d' ? 'solid' : 'outline'"
        label="3D"
        title="3D view, for looking (3)"
        @click="view = '3d'"
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
    <!-- While drawing, the hint takes the keys' place: both get a line of their own, one
         line tall, so the row (and the canvas under it) does not jump. -->
    <span
      v-if="!hint"
      class="basis-full truncate text-xs text-muted max-md:hidden"
    >H: navigate (drag pans) · I P E J: tools · Ctrl/Cmd+Z: undo · Esc: end trail · scroll: zoom · drag, right-drag or Space+drag: pan · F: frame top/bottom · 3: 3D view on/off · Esc: leave 3D · + − 0: zoom (0 fits) · [: side panel</span>
    <span
      v-if="hint"
      class="basis-full truncate font-mono text-xs"
      :title="hint"
    >{{ hint }}</span>
  </div>
</template>
