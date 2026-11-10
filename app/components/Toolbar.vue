<!-- eslint-disable vue/multi-word-component-names -- the plan names it Toolbar -->
<script setup lang="ts">
// The view switch, 2D or 3D, at the top left of the canvas in both views, before that view's framing
// buttons (2D) or camera presets (3D). Each view keeps its own other controls: zoom,
// fit and mirror in 2D; the camera presets in 3D. The editing tools and undo/redo are in
// the side panel's Edit tab.
import type { View } from '~/utils/boardView'

const props = defineProps<{
  /** What the canvas shows: a 2D framing or the 3D view. */
  view: View
}>()
const emit = defineEmits<{ mode: [mode: '2d' | '3d'] }>()

const is3d = computed(() => props.view === '3d')
</script>

<template>
  <div
    class="flex gap-1"
    role="group"
    aria-label="View"
  >
    <UButton
      size="xs"
      class="w-20 justify-center"
      :variant="is3d ? 'outline' : 'solid'"
      label="2D"
      title="2D view, for editing (3)"
      :aria-pressed="!is3d"
      @click="emit('mode', '2d')"
    />
    <UButton
      size="xs"
      class="w-20 justify-center"
      :variant="is3d ? 'solid' : 'outline'"
      label="3D"
      title="3D view, for looking (3)"
      :aria-pressed="is3d"
      @click="emit('mode', '3d')"
    />
  </div>
</template>
