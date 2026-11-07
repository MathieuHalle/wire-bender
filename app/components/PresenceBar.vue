<script setup lang="ts">
// Who else is on the board: one coloured initial per connected copy, its name in the tooltip.
import type { Peer } from '~/composables/useLiveBoard'

const props = defineProps<{ peers: Peer[] }>()

/** The initial of the device part of "Local · Tablet", else of the whole name. */
const initial = (name: string) => (name.split(' · ').at(-1) ?? name).trim().charAt(0).toUpperCase() || '?'
const title = computed(() => (props.peers.length
  ? `Also here: ${props.peers.map(p => p.name).join(', ')}`
  : 'No one else is on this board'))
</script>

<template>
  <div
    class="flex items-center -space-x-1"
    role="list"
    aria-label="Also on this board"
    :title="title"
  >
    <span
      v-for="(p, i) in peers"
      :key="i"
      role="listitem"
      class="inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-default"
      :style="{ backgroundColor: p.color }"
      :aria-label="p.name"
    >{{ initial(p.name) }}</span>
  </div>
</template>
