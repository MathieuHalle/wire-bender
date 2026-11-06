<script setup lang="ts">
// The 2D canvas's own controls, over its top-right corner: zoom, fit and the bottom mirror.
// The 3D view has its own (orbit, the camera presets); these only exist in 2D.
import { ZOOM_MAX, ZOOM_MIN } from '~/utils/camera2d'

defineProps<{
  /** The canvas zoom in percent of "fit both sides". */
  zoom: number
}>()
const emit = defineEmits<{ 'zoom-in': [], 'zoom-out': [], 'fit': [] }>()
const mirrorBottom = defineModel<boolean>('mirrorBottom', { required: true })
</script>

<template>
  <div class="flex items-center gap-3 rounded-md border border-default bg-default px-1 py-0.5 text-sm shadow-sm">
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
        title="Zoom out (-)"
        :disabled="zoom <= ZOOM_MIN * 100"
        @click="emit('zoom-out')"
      />
      <UButton
        size="xs"
        variant="ghost"
        class="w-12 justify-center font-mono"
        :label="`${zoom}%`"
        title="Fit both sides (0)"
        @click="emit('fit')"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-zoom-in"
        aria-label="Zoom in"
        title="Zoom in (+)"
        :disabled="zoom >= ZOOM_MAX * 100"
        @click="emit('zoom-in')"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-scan"
        label="Fit"
        title="Fit both sides (0)"
        @click="emit('fit')"
      />
    </div>
    <USwitch
      v-model="mirrorBottom"
      size="sm"
      class="pr-2"
      label="Mirror bottom"
    />
  </div>
</template>
