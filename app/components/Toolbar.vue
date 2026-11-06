<!-- eslint-disable vue/multi-word-component-names -- the plan names it Toolbar -->
<script setup lang="ts">
// The tool row: editing tools, view mode, mirror, undo/redo.
import type { Side } from '~core/schema'
import { ZOOM_STEPS, zoomStep, type Tool } from '~/utils/boardView'

defineProps<{
  canUndo: boolean
  canRedo: boolean
  /** Shown next to the tools, e.g. "Drawing T7 on bottom". */
  hint?: string | null
}>()
const emit = defineEmits<{ undo: [], redo: [] }>()

const tool = defineModel<Tool>('tool', { required: true })
const view = defineModel<'both' | Side>('view', { required: true })
const mirrorBottom = defineModel<boolean>('mirrorBottom', { required: true })
const zoom = defineModel<number>('zoom', { required: true })

const TOOLS: { id: Tool, label: string, icon: string, key: string }[] = [
  { id: 'inspect', label: 'Inspect', icon: 'i-lucide-mouse-pointer-2', key: 'I' },
  { id: 'pencil', label: 'Pencil', icon: 'i-lucide-pencil', key: 'P' },
  { id: 'erase', label: 'Erase', icon: 'i-lucide-eraser', key: 'E' },
  { id: 'joint', label: 'Joint', icon: 'i-lucide-circle-dot', key: 'J' }
]
</script>

<template>
  <div class="flex flex-wrap items-center gap-4 border-b border-default px-4 py-2 text-sm">
    <div
      class="flex gap-1"
      role="toolbar"
      aria-label="Tools"
    >
      <UButton
        v-for="t in TOOLS"
        :key="t.id"
        size="xs"
        :icon="t.icon"
        :variant="tool === t.id ? 'solid' : 'outline'"
        :label="t.label"
        :title="`${t.label} (${t.key})`"
        :aria-pressed="tool === t.id"
        @click="tool = t.id"
      />
    </div>
    <div class="flex gap-1">
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-undo-2"
        aria-label="Undo"
        title="Undo (Ctrl/Cmd+Z)"
        :disabled="!canUndo"
        @click="emit('undo')"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-redo-2"
        aria-label="Redo"
        title="Redo (Shift+Ctrl/Cmd+Z)"
        :disabled="!canRedo"
        @click="emit('redo')"
      />
    </div>
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
        title="Zoom out (-)"
        :disabled="zoom <= ZOOM_STEPS[0]!"
        @click="zoom = zoomStep(zoom, -1)"
      />
      <UButton
        size="xs"
        variant="ghost"
        class="w-12 justify-center font-mono"
        :label="`${Math.round(zoom * 100)}%`"
        title="Fit the width (0)"
        @click="zoom = 1"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-zoom-in"
        aria-label="Zoom in"
        title="Zoom in (+)"
        :disabled="zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!"
        @click="zoom = zoomStep(zoom, 1)"
      />
    </div>
    <USwitch
      v-model="mirrorBottom"
      label="Mirror bottom"
    />
    <span class="text-xs text-muted">I P E J: tools · Esc: end trail · F: one large side, flip · + − 0: zoom</span>
    <span
      v-if="hint"
      class="font-mono text-xs"
    >{{ hint }}</span>
  </div>
</template>
