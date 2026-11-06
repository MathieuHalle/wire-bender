<!-- eslint-disable vue/multi-word-component-names -- the plan names it Toolbar -->
<script setup lang="ts">
// The tool row: editing tools, view mode, mirror, undo/redo.
import { LOCKED_TITLE, lockedAttrs, ZOOM_STEPS, zoomStep, type Tool, type View } from '~/utils/boardView'

defineProps<{
  canUndo: boolean
  canRedo: boolean
  /** Shown next to the tools, e.g. "Drawing T7 on bottom". */
  hint?: string | null
}>()
const emit = defineEmits<{ undo: [], redo: [] }>()

const tool = defineModel<Tool>('tool', { required: true })
const view = defineModel<View>('view', { required: true })
const mirrorBottom = defineModel<boolean>('mirrorBottom', { required: true })
const zoom = defineModel<number>('zoom', { required: true })

/** The 3D view is read-only: the edit tools, undo/redo, mirror and zoom are off there. */
const locked = computed(() => view.value === '3d')

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
      :title="locked ? LOCKED_TITLE : undefined"
    >
      <UButton
        v-for="t in TOOLS"
        :key="t.id"
        size="xs"
        :icon="t.icon"
        :variant="tool === t.id ? 'solid' : 'outline'"
        :label="t.label"
        :title="locked ? LOCKED_TITLE : `${t.label} (${t.key})`"
        :aria-pressed="tool === t.id"
        :disabled="locked"
        @click="locked || (tool = t.id)"
      />
    </div>
    <div class="flex gap-1">
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-undo-2"
        aria-label="Undo"
        :title="locked ? LOCKED_TITLE : 'Undo (Ctrl/Cmd+Z)'"
        :disabled="locked || !canUndo"
        @click="emit('undo')"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-redo-2"
        aria-label="Redo"
        :title="locked ? LOCKED_TITLE : 'Redo (Shift+Ctrl/Cmd+Z)'"
        :disabled="locked || !canRedo"
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
    <span class="text-xs text-muted">I P E J: tools · Esc: end trail · F: one large side, flip · 3: 3D view on/off · Esc: leave 3D · + − 0: zoom</span>
    <span
      v-if="hint"
      class="font-mono text-xs"
    >{{ hint }}</span>
  </div>
</template>
