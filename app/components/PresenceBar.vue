<script setup lang="ts">
// Who else is on the board: one avatar (a signed-in person's, from their sign-in provider)
// or coloured initial per connected copy, its name in the tooltip. Signed-out visitors are
// `Guest`.
import type { Peer } from '~/composables/useLiveBoard'

const props = defineProps<{ peers: Peer[] }>()

/** The initial of the device part of "Local · Tablet", else of the whole name. */
const initial = (name: string) => (name.split(' · ').at(-1) ?? name).trim().charAt(0).toUpperCase() || '?'
const shown = computed(() => props.peers.map(p => ({ ...p, avatar: safeAvatar(p.avatar) })))
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
    <template
      v-for="(p, i) in shown"
      :key="i"
    >
      <img
        v-if="p.avatar"
        role="listitem"
        class="size-6 rounded-full ring-2 ring-default"
        :src="p.avatar"
        :alt="p.name"
        :aria-label="p.name"
        width="24"
        height="24"
        referrerpolicy="no-referrer"
      >
      <span
        v-else
        role="listitem"
        class="inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-default"
        :style="{ backgroundColor: p.color }"
        :aria-label="p.name"
      >{{ initial(p.name) }}</span>
    </template>
  </div>
</template>
