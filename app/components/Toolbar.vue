<!-- eslint-disable vue/multi-word-component-names -- the plan names it Toolbar -->
<script setup lang="ts">
// The view row: view mode, zoom, mirror, the keys, and the drawing hint. The editing
// tools and undo/redo are in the side panel's Edit tab.
import { lockedAttrs, ZOOM_STEPS, zoomStep, type View } from '~/utils/boardView'

defineProps<{
  /** Shown near the board, e.g. "Drawing T7 on bottom", so it stays in view with the panel collapsed. */
  hint?: string | null
}>()

const view = defineModel<View>('view', { required: true })
const mirrorBottom = defineModel<boolean>('mirrorBottom', { required: true })
const zoom = defineModel<number>('zoom', { required: true })

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
        :disabled="locked || zoom <= ZOOM_STEPS[0]!"
        @click="zoom = zoomStep(zoom, -1)"
      />
      <UButton
        size="xs"
        variant="ghost"
        class="w-12 justify-center font-mono"
        :label="`${Math.round(zoom * 100)}%`"
        v-bind="lockedAttrs(locked, 'Fit the width (0)')"
        @click="zoom = 1"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-zoom-in"
        aria-label="Zoom in"
        :title="lockedAttrs(locked, 'Zoom in (+)').title"
        :disabled="locked || zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!"
        @click="zoom = zoomStep(zoom, 1)"
      />
    </div>
    <USwitch
      v-model="mirrorBottom"
      label="Mirror bottom"
      v-bind="lockedAttrs(locked)"
    />
    <span class="text-xs text-muted">I P E J: tools · Ctrl/Cmd+Z: undo · Esc: end trail · F: one large side, flip · 3: 3D view on/off · Esc: leave 3D · + − 0: zoom · [: side panel</span>
    <span
      v-if="hint"
      class="font-mono text-xs"
    >{{ hint }}</span>
  </div>
</template>
