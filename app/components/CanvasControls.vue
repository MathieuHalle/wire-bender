<script setup lang="ts">
// The 2D canvas's own controls, over its top-right corner: zoom, fit, the bottom mirror and
// which way it turns the board over. The 3D view has its own (orbit, the camera presets);
// these only exist in 2D.
import type { Flip } from '~core/sideView'
import { ZOOM_MAX, ZOOM_MIN } from '~/utils/camera2d'

defineProps<{
  /** The canvas zoom in percent of "fit both sides". */
  zoom: number
}>()
const emit = defineEmits<{ 'zoom-in': [], 'zoom-out': [], 'fit': [] }>()
const mirrorBottom = defineModel<boolean>('mirrorBottom', { required: true })
/** Left-right (turned over sideways) or top-bottom (end over end); only drawn while mirrored. */
const flip = defineModel<Flip>('flip', { required: true })

const FLIP_CHOICES = [
  { id: 'lr', label: 'L↔R', title: 'Mirror left↔right: the board turned over sideways' },
  { id: 'tb', label: 'T↔B', title: 'Mirror top↔bottom: the board turned over end over end' }
] as const
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
    <div
      class="-ml-1 flex items-center pr-1"
      role="group"
      aria-label="Mirror the bottom"
    >
      <UButton
        v-for="(c, i) in FLIP_CHOICES"
        :key="c.id"
        size="xs"
        color="neutral"
        :variant="flip === c.id ? 'solid' : 'outline'"
        :class="i === 0 ? 'rounded-r-none' : 'rounded-l-none -ml-px'"
        :label="c.label"
        :title="mirrorBottom ? c.title : `${c.title} (turn Mirror bottom on to use it)`"
        :aria-pressed="flip === c.id"
        :disabled="!mirrorBottom"
        @click="flip = c.id"
      />
    </div>
  </div>
</template>
