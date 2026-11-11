<script setup lang="ts">
// The command palette: the user's boards (read once, when first opened) and the sidebar's destinations.
import type { CommandPaletteGroup } from '@nuxt/ui'
import { BOARD_LIST_LINKS, boardLists, type BoardList } from '~/utils/nav'

const { me } = useMe()
const open = ref(false)
const boards = ref<{ label: string, icon: string, to: string }[]>([])
let loaded = false

watch(open, async (isOpen) => {
  if (!isOpen || loaded) return
  loaded = true
  try {
    // Typed by hand: $fetch's route typing for this URL is too deep for vue-tsc.
    const get = $fetch as (url: string, opts: { query: object }) => Promise<{ id: string, name: string }[]>
    const rows = await get('/api/boards', { query: { list: 'mine' } })
    boards.value = rows.map(b => ({ label: b.name, icon: 'i-lucide-circuit-board', to: `/b/${b.id}` }))
  } catch {
    loaded = false
  }
})

const groups = computed<CommandPaletteGroup[]>(() => [
  { id: 'boards', label: 'Boards', items: boards.value },
  {
    id: 'go',
    label: 'Go to',
    items: [
      ...(me.value ? boardLists(me.value) : ['mine', 'trash'] as BoardList[]).map(k => BOARD_LIST_LINKS[k]),
      { label: 'Settings', to: '/settings', icon: 'i-lucide-settings' }
    ]
  }
])
</script>

<template>
  <UDashboardSearch
    v-model:open="open"
    :groups="groups"
    placeholder="Search boards and pages..."
  />
</template>
