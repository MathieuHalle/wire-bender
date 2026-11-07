<script setup lang="ts">
// The side panel's Edit tab: the tools, undo/redo, and the view layers. The editing tools
// are off in 3D (look only) and while the board is not live, Navigate (pan, no edits) stays on; the layers work in both
// views and never touch the file.
import { LOCKED_TITLE, type Tool } from '~/utils/boardView'
import { blindHint, type Layers } from '~/utils/layers'

const props = defineProps<{
  canUndo: boolean
  canRedo: boolean
  /** No edits: the 3D view, or a board not live. */
  locked?: boolean
  /** Why editing is off; the 3D view's reason by default. */
  lockedTitle?: string
}>()
const emit = defineEmits<{ undo: [], redo: [] }>()

const tool = defineModel<Tool>('tool', { required: true })
const layers = defineModel<Layers>('layers', { required: true })

const TOOLS: { id: Tool, label: string, icon: string, key: string }[] = [
  { id: 'navigate', label: 'Navigate', icon: 'i-lucide-hand', key: 'H' },
  { id: 'inspect', label: 'Inspect', icon: 'i-lucide-mouse-pointer-2', key: 'I' },
  { id: 'pencil', label: 'Pencil', icon: 'i-lucide-pencil', key: 'P' },
  { id: 'erase', label: 'Erase', icon: 'i-lucide-eraser', key: 'E' },
  { id: 'joint', label: 'Joint', icon: 'i-lucide-circle-dot', key: 'J' }
]

const LAYERS: { id: keyof Layers, label: string, description: string }[] = [
  { id: 'components', label: 'Components', description: 'Part bodies, labels and legs' },
  { id: 'wires', label: 'Wires', description: 'Insulated wires, laid and flying' },
  { id: 'trails', label: 'Trails', description: 'Bare trails, their joints, leg-folds, bridges' }
]

function setLayer(id: keyof Layers, on: boolean) {
  layers.value = { ...layers.value, [id]: on }
}

const lockTitle = computed(() => props.lockedTitle ?? LOCKED_TITLE)
const blind = computed(() => (props.locked ? null : blindHint(tool.value, layers.value)))
</script>

<template>
  <div class="space-y-4 text-sm">
    <section>
      <h2 class="mb-2 text-lg font-medium">
        Tools
      </h2>
      <div
        class="grid grid-cols-2 gap-1"
        role="toolbar"
        aria-label="Tools"
        :title="locked ? lockTitle : undefined"
      >
        <UButton
          v-for="t in TOOLS"
          :key="t.id"
          size="xs"
          :icon="t.icon"
          :variant="tool === t.id ? 'solid' : 'outline'"
          :label="`${t.label} (${t.key})`"
          :title="locked && t.id !== 'navigate' ? lockTitle : `${t.label} (${t.key})`"
          :aria-pressed="tool === t.id"
          :disabled="locked && t.id !== 'navigate'"
          @click="(locked && t.id !== 'navigate') || (tool = t.id)"
        />
      </div>
      <div class="mt-2 flex gap-1">
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-undo-2"
          label="Undo"
          :title="locked ? lockTitle : 'Undo (Ctrl/Cmd+Z)'"
          :disabled="locked || !canUndo"
          @click="emit('undo')"
        />
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-redo-2"
          label="Redo"
          :title="locked ? lockTitle : 'Redo (Shift+Ctrl/Cmd+Z)'"
          :disabled="locked || !canRedo"
          @click="emit('redo')"
        />
      </div>
      <p
        v-if="blind"
        class="mt-2 text-xs text-warning"
        role="status"
      >
        {{ blind }}
      </p>
    </section>

    <section>
      <h2 class="mb-1 text-lg font-medium">
        Layers
      </h2>
      <p class="mb-2 text-xs text-muted">
        View only: the board file and the check are unchanged. Holes and pads always show.
      </p>
      <div class="space-y-2">
        <USwitch
          v-for="l in LAYERS"
          :key="l.id"
          :model-value="layers[l.id]"
          :label="l.label"
          :description="l.description"
          size="sm"
          @update:model-value="(on: boolean) => setLayer(l.id, on)"
        />
      </div>
    </section>
  </div>
</template>
