<script setup lang="ts">
// The board's revisions, newest first. Picking a row previews that revision (the page swaps
// the canvas and shows the banner); the list reloads whenever the head `revision` changes.
import { howLabel, relativeTime, type RevisionRow } from '~/utils/history'

const props = defineProps<{
  boardId: string
  /** The head revision; the list reloads when it changes. */
  revision: number
}>()
/** The revision row on show, or null for the current board. */
const selected = defineModel<RevisionRow | null>('selected', { default: null })

const rows = ref<RevisionRow[]>([])
const error = ref(false)
const now = ref(Date.now())

async function load() {
  try {
    rows.value = await $fetch<RevisionRow[]>(`/api/boards/${encodeURIComponent(props.boardId)}/revisions`)
    error.value = false
    now.value = Date.now()
  } catch {
    error.value = true
  }
}
watch(() => [props.boardId, props.revision] as const, load, { immediate: true })

const pick = (r: RevisionRow) => (selected.value = selected.value?.n === r.n ? null : r)
</script>

<template>
  <div class="flex flex-col gap-1">
    <p
      v-if="error"
      class="text-sm text-error"
    >
      The history could not be loaded.
    </p>
    <p
      v-else-if="!rows.length"
      class="text-sm text-muted"
    >
      No revisions yet.
    </p>
    <ul
      v-else
      class="flex flex-col gap-1"
    >
      <li
        v-for="r in rows"
        :key="r.n"
      >
        <button
          type="button"
          class="w-full rounded border px-2 py-1 text-left text-sm hover:bg-elevated"
          :class="selected?.n === r.n ? 'border-primary bg-elevated' : 'border-default'"
          :aria-pressed="selected?.n === r.n"
          @click="pick(r)"
        >
          <span class="flex items-center gap-2">
            <span class="font-mono font-semibold">#{{ r.n }}</span>
            <span class="text-xs text-muted">{{ relativeTime(r.createdAt, now) }}</span>
            <UBadge
              class="ml-auto"
              size="sm"
              variant="subtle"
              color="neutral"
              :label="howLabel(r)"
            />
          </span>
          <span class="block truncate text-xs text-muted">{{ r.author }}</span>
          <span class="block text-xs">{{ r.summary }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
