<script setup lang="ts">
// The side panel's Edit tab: the tools and undo/redo. The editing tools are off in 3D
// (look only) and while the board is not live, Navigate (pan, no edits) stays on. The view
// layers are in the Layers tab; this one only reads them, to warn while drawing blind.
import { LOCKED_TITLE, type Tool } from '~/utils/boardView'
import { blindHint, type Layers } from '~/utils/layers'
import { MOUNT_SIZES, type MountSize } from '~core/editFeatures'
import type { BlockKind } from '~/composables/useTools'

const props = defineProps<{
  canUndo: boolean
  canRedo: boolean
  /** No edits: the 3D view, or a board not live. */
  locked?: boolean
  /** Why editing is off; the 3D view's reason by default. */
  lockedTitle?: string
  /** The link gives view only: no undo or redo to offer. */
  viewOnly?: boolean
  /** The view layers (set in the Layers tab). */
  layers: Layers
  /** A breadboard: the pencil draws jumpers, and there is no Joint tool (nothing is soldered). */
  breadboard?: boolean
  /** A stripboard: the Cut tool cuts its strips (no other board has it). */
  stripboard?: boolean
}>()
const emit = defineEmits<{ undo: [], redo: [] }>()

const tool = defineModel<Tool>('tool', { required: true })

const TOOLS: { id: Tool, label: string, icon: string, key: string }[] = [
  { id: 'navigate', label: 'Navigate', icon: 'i-lucide-hand', key: 'H' },
  { id: 'inspect', label: 'Inspect', icon: 'i-lucide-mouse-pointer-2', key: 'I' },
  { id: 'pencil', label: 'Pencil', icon: 'i-lucide-pencil', key: 'P' },
  { id: 'erase', label: 'Erase', icon: 'i-lucide-eraser', key: 'E' },
  { id: 'joint', label: 'Joint', icon: 'i-lucide-circle-dot', key: 'J' },
  { id: 'move', label: 'Move', icon: 'i-lucide-move', key: 'M' },
  { id: 'cut', label: 'Cut', icon: 'i-lucide-scissors', key: 'C' },
  { id: 'block', label: 'Block', icon: 'i-lucide-square-dashed', key: 'B' }
]

const blockKind = defineModel<BlockKind>('blockKind', { default: 'zone' })
const blockReason = defineModel<string>('blockReason', { default: 'keep clear' })
const mountSize = defineModel<MountSize>('mountSize', { default: 'M3' })
const BLOCK_KINDS = [
  { label: 'No-go zone', value: 'zone' },
  { label: 'Cutout', value: 'cutout' },
  { label: 'Mounting hole', value: 'mount' }
]
const REASONS = ['keep clear', 'heatsink', 'standoff', 'connector', 'mounting hole', 'enclosure rib']
const SIZES = MOUNT_SIZES.map(m => ({ label: `${m.id} (${m.diameterMm} mm hole)`, value: m.id }))

const tools = computed(() => {
  const own = TOOLS.filter(t => t.id !== 'cut' || props.stripboard)
  return props.breadboard
    ? own.filter(t => t.id !== 'joint').map(t => (t.id === 'pencil' ? { ...t, label: 'Jumper', icon: 'i-lucide-spline' } : t))
    : own
})

const lockTitle = computed(() => props.lockedTitle ?? LOCKED_TITLE)
const blind = computed(() => (props.locked ? null : blindHint(tool.value, props.layers)))
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
          v-for="t in tools"
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
      <div
        v-if="tool === 'block' && !locked"
        class="mt-2 space-y-2"
      >
        <USelect
          v-model="blockKind"
          :items="BLOCK_KINDS"
          size="xs"
          class="w-full"
          aria-label="What the Block tool makes"
        />
        <UInputMenu
          v-if="blockKind !== 'mount'"
          v-model="blockReason"
          :items="REASONS"
          create-item
          size="xs"
          class="w-full"
          aria-label="Reason"
          @create="(r: string) => (blockReason = r)"
        />
        <USelect
          v-else
          v-model="mountSize"
          :items="SIZES"
          size="xs"
          class="w-full"
          aria-label="Mounting hole size"
        />
        <p class="text-xs text-muted">
          {{ blockKind === 'mount' ? 'Click where the hole goes (it snaps to half a pitch).' : 'Click one corner hole, then the other.' }}
          Click a zone, cutout or mounting hole to remove it.
        </p>
      </div>
      <div
        v-if="!viewOnly"
        class="mt-2 flex gap-1"
      >
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
  </div>
</template>
