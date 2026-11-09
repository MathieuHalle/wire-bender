<script setup lang="ts">
// The Board tab: the name (the owner renames it here), when it was made and last changed,
// where it was forked from, its size, and the two downloads. Facts come from the revision
// list, reloaded while the tab is on show whenever the head `revision` changes.
import type { BoardFile } from '~core'
import type { BoardMeta } from '~/composables/useLiveBoard'
import { boardBytes, boardFacts, formatBytes } from '~/utils/boardInfo'
import { saveZip } from '~/utils/download'
import { relativeTime, type RevisionRow } from '~/utils/history'

const props = defineProps<{
  /** The key the board was opened by: its id (the owner) or a share link id. */
  boardId: string
  board: BoardFile | null
  meta: BoardMeta | null
  revision: number
  /** The tab is on show; the list only loads then. */
  active: boolean
}>()

const toast = useToast()
const isOwner = computed(() => props.meta?.role === 'owner')
const key = computed(() => encodeURIComponent(props.boardId))

// The facts.
const rows = ref<RevisionRow[]>([])
const error = ref(false)
const now = ref(Date.now())
let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  try {
    const list = await $fetch<RevisionRow[]>(`/api/boards/${key.value}/revisions`)
    if (seq !== loadSeq) return
    rows.value = list
    error.value = false
    now.value = Date.now()
  } catch {
    if (seq === loadSeq) error.value = true
  }
}
watch(() => props.boardId, () => {
  rows.value = []
  error.value = false
})
watch(() => [props.active, props.boardId, props.revision] as const, ([active]) => {
  if (active) void load()
}, { immediate: true })
const facts = computed(() => boardFacts(rows.value))
const size = computed(() => (props.board ? formatBytes(boardBytes(props.board)) : null))
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

// Rename (the owner only): Enter or leaving the field saves, Esc puts the name back.
const name = ref('')
const renameError = ref<string | null>(null)
const saving = ref(false)
watch(() => props.board?.name, (n) => {
  if (n !== undefined && !saving.value) name.value = n
}, { immediate: true })
async function rename() {
  const next = name.value.trim()
  if (!props.board || next === props.board.name || saving.value) {
    if (next === '') name.value = props.board?.name ?? ''
    return
  }
  if (next === '') {
    renameError.value = 'The name cannot be empty.'
    return
  }
  saving.value = true
  try {
    await $fetch(`/api/boards/${key.value}`, { method: 'PATCH', body: { name: next } })
    renameError.value = null
    name.value = next
    toast.add({ title: `Renamed to ${next}`, color: 'success', icon: 'i-lucide-check' })
  } catch (e) {
    const data = (e as { data?: { errors?: unknown, error?: unknown } }).data
    renameError.value = Array.isArray(data?.errors) ? data.errors.map(String).join(' ') : typeof data?.error === 'string' ? data.error : (e as Error).message
  } finally {
    saving.value = false
  }
}
function revert(e: KeyboardEvent) {
  name.value = props.board?.name ?? ''
  renameError.value = null
  ;(e.target as HTMLInputElement).blur()
}

// Downloads. The board file is an attachment, so the browser saves it and stays here; the
// bundle goes through fetch, which can show a refusal (the rate limit) as a toast.
const downloadFile = () => window.location.assign(`/api/boards/${key.value}/download`)
async function downloadBundle() {
  const refused = await saveZip(`/api/boards/${key.value}/bundle`, 'board.wirebender.zip')
  if (refused) toast.add({ title: refused, color: 'error', icon: 'i-lucide-ban' })
}
</script>

<template>
  <div class="flex flex-col gap-4 text-sm">
    <section class="flex flex-col gap-1">
      <label
        v-if="isOwner"
        for="board-info-name"
        class="text-xs font-medium text-muted"
      >Name</label>
      <UInput
        v-if="isOwner"
        id="board-info-name"
        v-model="name"
        :disabled="saving"
        :color="renameError ? 'error' : undefined"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
        @keydown.esc="revert"
        @blur="rename"
      />
      <p
        v-else
        class="font-medium"
      >
        {{ board?.name ?? meta?.name }}
      </p>
      <p
        v-if="renameError"
        class="text-xs text-error"
      >
        {{ renameError }}
      </p>
    </section>

    <p
      v-if="error"
      class="text-error"
    >
      The board's details could not be loaded.
    </p>
    <dl
      v-else-if="facts"
      class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"
    >
      <dt class="text-muted">
        Created
      </dt>
      <dd>{{ day(facts.createdAt) }}</dd>
      <dt class="text-muted">
        Last change
      </dt>
      <dd>#{{ facts.last.n }} · {{ relativeTime(facts.last.at, now) }} · {{ facts.last.author }}</dd>
      <template v-if="meta?.forkedFrom">
        <dt class="text-muted">
          Forked from
        </dt>
        <dd>
          <NuxtLink
            :to="`/b/${encodeURIComponent(meta.forkedFrom.key)}`"
            class="text-primary underline"
          >{{ meta.forkedFrom.name }}</NuxtLink>
        </dd>
      </template>
      <template v-if="meta && !isOwner">
        <dt class="text-muted">
          Owner
        </dt>
        <dd>{{ meta.owner.name }}</dd>
      </template>
      <dt class="text-muted">
        Size
      </dt>
      <dd>{{ size }} · {{ facts.revisions }} {{ facts.revisions === 1 ? 'revision' : 'revisions' }}</dd>
    </dl>

    <section class="flex flex-col gap-2">
      <h3 class="text-xs font-medium text-muted">
        Download
      </h3>
      <UButton
        icon="i-lucide-download"
        color="neutral"
        variant="outline"
        label="Board file"
        block
        @click="downloadFile"
      />
      <UButton
        icon="i-lucide-history"
        color="neutral"
        variant="outline"
        label="Board with history"
        block
        @click="downloadBundle"
      />
    </section>
  </div>
</template>
