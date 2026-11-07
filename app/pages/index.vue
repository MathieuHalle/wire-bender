<script setup lang="ts">
// The board list: newest change first. New board, import a .wirebender.json file, and per
// board: open, rename, download.
interface BoardRow { id: string, name: string, head: number, updatedAt: number, author: string }

// Times are local to the browser: loaded on the client only, so the server never renders them.
const { data: boards, status, refresh } = useFetch<BoardRow[]>('/api/boards', { server: false, default: () => [] })
const toast = useToast()

const EMPTY = 'No boards yet. Import a .wirebender.json file or start a new board.'
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The errors of a failed request: the API's 422 list, or its message. */
function errorsOf(e: unknown): string[] {
  const data = (e as { data?: { errors?: unknown, error?: unknown } }).data
  if (Array.isArray(data?.errors)) return data.errors.map(String)
  if (typeof data?.error === 'string') return [data.error]
  return [(e as Error).message]
}

// New board.
const creating = ref(false)
const draft = ref({ name: '', cols: 30, rows: 20, type: 'one-sided' as 'one-sided' | 'two-sided' })
const createErrors = ref<string[]>([])
const SIDES = [
  { label: 'One-sided', value: 'one-sided' },
  { label: 'Two-sided', value: 'two-sided' }
]
function openNew() {
  draft.value = { name: '', cols: 30, rows: 20, type: 'one-sided' }
  createErrors.value = []
  creating.value = true
}
async function create() {
  try {
    const { id } = await $fetch<{ id: string }>('/api/boards', { method: 'POST', body: draft.value })
    creating.value = false
    await navigateTo(`/b/${id}`)
  } catch (e) {
    createErrors.value = errorsOf(e)
  }
}

// Import.
const picker = ref<HTMLInputElement | null>(null)
const importErrors = ref<{ file: string, errors: string[] } | null>(null)
async function onPick(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importErrors.value = null
  let board: unknown
  try {
    board = JSON.parse(await file.text())
  } catch (e) {
    importErrors.value = { file: file.name, errors: [`not valid JSON: ${(e as Error).message}`] }
    return
  }
  try {
    const { id } = await $fetch<{ id: string }>('/api/boards', { method: 'POST', body: { board } })
    await navigateTo(`/b/${id}`)
  } catch (e) {
    importErrors.value = { file: file.name, errors: errorsOf(e) }
  }
}

// Rename.
const renaming = ref<BoardRow | null>(null)
const newName = ref('')
const renameErrors = ref<string[]>([])
function openRename(b: BoardRow) {
  renaming.value = b
  newName.value = b.name
  renameErrors.value = []
}
async function rename() {
  const b = renaming.value
  if (!b) return
  try {
    await $fetch(`/api/boards/${b.id}`, { method: 'PATCH', body: { name: newName.value } })
    renaming.value = null
    toast.add({ title: `Renamed to ${newName.value.trim()}`, color: 'success', icon: 'i-lucide-check' })
    await refresh()
  } catch (e) {
    renameErrors.value = errorsOf(e)
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-4 p-4">
    <header class="flex flex-wrap items-center gap-3">
      <img
        src="/icon.svg"
        alt=""
        width="28"
        height="28"
      >
      <h1 class="text-xl font-semibold">
        Boards
      </h1>
      <div class="ml-auto flex gap-2">
        <UButton
          icon="i-lucide-upload"
          variant="outline"
          label="Import"
          @click="picker?.click()"
        />
        <UButton
          icon="i-lucide-plus"
          label="New board"
          @click="openNew"
        />
      </div>
      <input
        ref="picker"
        type="file"
        accept=".json,application/json"
        class="hidden"
        @change="onPick"
      >
    </header>

    <UAlert
      v-if="importErrors"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="`${importErrors.file} was not imported`"
      close
      @update:open="importErrors = null"
    >
      <template #description>
        <ul class="max-h-[40dvh] overflow-y-auto font-mono text-xs">
          <li
            v-for="e in importErrors.errors"
            :key="e"
          >
            {{ e }}
          </li>
        </ul>
      </template>
    </UAlert>

    <p
      v-if="status === 'pending' || status === 'idle'"
      class="text-muted"
    >
      Loading boards…
    </p>
    <p
      v-else-if="status === 'error'"
      class="text-error"
    >
      Cannot reach the WireBender server.
    </p>
    <p
      v-else-if="!boards.length"
      class="text-muted"
    >
      {{ EMPTY }}
    </p>
    <table
      v-else
      class="w-full text-left text-sm"
    >
      <thead class="border-b border-default text-muted">
        <tr>
          <th class="py-2 font-medium">
            Name
          </th>
          <th class="py-2 font-medium">
            Last change
          </th>
          <th class="py-2 text-right font-medium">
            Revision
          </th>
          <th class="py-2">
            <span class="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="b in boards"
          :key="b.id"
          class="border-b border-default"
        >
          <td class="py-2">
            <NuxtLink
              :to="`/b/${b.id}`"
              class="font-medium hover:underline"
            >
              {{ b.name }}
            </NuxtLink>
          </td>
          <td class="py-2 text-muted">
            {{ when(b.updatedAt) }} · {{ b.author }}
          </td>
          <td class="py-2 text-right font-mono">
            {{ b.head }}
          </td>
          <td class="py-2">
            <div class="flex justify-end gap-1">
              <UButton
                size="xs"
                label="Open"
                :to="`/b/${b.id}`"
              />
              <UButton
                size="xs"
                variant="outline"
                label="Rename"
                @click="openRename(b)"
              />
              <UButton
                size="xs"
                variant="ghost"
                icon="i-lucide-download"
                label="Download"
                :href="`/api/boards/${b.id}/download`"
                download
                external
              />
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <UModal
      v-model:open="creating"
      title="New board"
    >
      <template #body>
        <form
          id="new-board"
          class="space-y-3"
          @submit.prevent="create"
        >
          <UFormField
            label="Name"
            required
          >
            <UInput
              v-model="draft.name"
              class="w-full"
              autofocus
            />
          </UFormField>
          <div class="flex gap-3">
            <UFormField label="Columns">
              <UInputNumber
                v-model="draft.cols"
                :min="1"
              />
            </UFormField>
            <UFormField label="Rows">
              <UInputNumber
                v-model="draft.rows"
                :min="1"
              />
            </UFormField>
          </div>
          <URadioGroup
            v-model="draft.type"
            legend="Copper"
            orientation="horizontal"
            :items="SIDES"
          />
          <ul
            v-if="createErrors.length"
            class="font-mono text-xs text-error"
          >
            <li
              v-for="e in createErrors"
              :key="e"
            >
              {{ e }}
            </li>
          </ul>
        </form>
      </template>
      <template #footer>
        <UButton
          variant="ghost"
          label="Cancel"
          @click="creating = false"
        />
        <UButton
          type="submit"
          form="new-board"
          label="Create"
        />
      </template>
    </UModal>

    <UModal
      :open="renaming !== null"
      title="Rename board"
      @update:open="(o: boolean) => o || (renaming = null)"
    >
      <template #body>
        <form
          id="rename-board"
          class="space-y-3"
          @submit.prevent="rename"
        >
          <UFormField label="Name">
            <UInput
              v-model="newName"
              class="w-full"
              autofocus
            />
          </UFormField>
          <ul
            v-if="renameErrors.length"
            class="font-mono text-xs text-error"
          >
            <li
              v-for="e in renameErrors"
              :key="e"
            >
              {{ e }}
            </li>
          </ul>
        </form>
      </template>
      <template #footer>
        <UButton
          variant="ghost"
          label="Cancel"
          @click="renaming = null"
        />
        <UButton
          type="submit"
          form="rename-board"
          label="Rename"
        />
      </template>
    </UModal>
  </div>
</template>
