<script setup lang="ts">
import { RETURN_KEY, returnPath } from '~/utils/boardView'

// The board lists: My boards (newest change first), Shared with me (public mode: boards
// opened by someone else's link, by their link id only), and Trash (Restore, or Delete for
// good after typing the name). New board and Import make boards of mine. Signed out in
// public mode, a short intro with the sign-in buttons instead. Local mode opens the lists
// straight away, as in step 1, with no account and no sharing.
type Visibility = 'view' | 'edit' | 'private'
type List = 'mine' | 'shared' | 'trash'
interface BoardRow { id: string, name: string, head: number, updatedAt: number, author: string, visibility: Visibility, hasPassword: boolean, trashedAt: number | null }
interface SharedRow { key: string, name: string, owner: string, role: 'view' | 'edit', lastOpened: number }

const { me, failed: meFailed, load: loadMe } = useMe()
const toast = useToast()

const mode = computed(() => me.value?.mode ?? null)
const user = computed(() => me.value?.user ?? null)
const isPublic = computed(() => mode.value === 'public')
/** Public mode, nobody signed in: the intro. */
const signedOut = computed(() => isPublic.value && !user.value)
/** The lists are for the local user, or a signed-in one. */
const canList = computed(() => mode.value === 'local' || (isPublic.value && !!user.value))

const EMPTY: Record<List, string> = {
  mine: 'No boards yet. Import a .wirebender.json file or start a new board.',
  shared: 'Nothing shared with you yet. Boards you open from someone else\'s link show up here.',
  trash: 'The trash is empty.'
}
const TRASH_DAYS = 30
const DAY_MS = 24 * 3600 * 1000
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' })

/** The errors of a failed request: the API's 422 list, or its message. */
function errorsOf(e: unknown): string[] {
  const data = (e as { data?: { errors?: unknown, error?: unknown } }).data
  if (Array.isArray(data?.errors)) return data.errors.map(String)
  if (typeof data?.error === 'string') return [data.error]
  return [(e as Error).message]
}
const failToast = (e: unknown) => toast.add({ title: errorsOf(e).join(' '), color: 'error', icon: 'i-lucide-ban' })

// The tabs.
const tab = ref<List>('mine')
const TABS = computed(() => [
  { label: 'My boards', value: 'mine', icon: 'i-lucide-layout-grid' },
  ...(isPublic.value ? [{ label: 'Shared with me', value: 'shared', icon: 'i-lucide-users' }] : []),
  { label: 'Trash', value: 'trash', icon: 'i-lucide-trash-2' }
])

// The list on show. Times are local to the browser: everything here loads on the client only.
const rows = ref<BoardRow[]>([])
const sharedRows = ref<SharedRow[]>([])
const listStatus = ref<'idle' | 'pending' | 'success' | 'error'>('idle')
async function loadList() {
  if (!canList.value) return
  const which = tab.value
  listStatus.value = 'pending'
  try {
    const body = await $fetch<BoardRow[] | SharedRow[]>('/api/boards', { query: { list: which } })
    if (which !== tab.value) return
    if (which === 'shared') sharedRows.value = body as SharedRow[]
    else rows.value = body as BoardRow[]
    listStatus.value = 'success'
  } catch (e) {
    if (which !== tab.value) return
    // Signed out meanwhile (another tab): show the intro.
    if ((e as { statusCode?: number }).statusCode === 401 && isPublic.value) {
      const now = await loadMe(true)
      // Still signed in (or /api/me unreachable): the list really failed; never "Loading…" for ever.
      if ((now && !now.user) || which !== tab.value) return
    }
    listStatus.value = 'error'
  }
}
watch(tab, () => void loadList())
onMounted(async () => {
  await loadMe()
  // Signed in from a board ("Sign in to edit"): back to it.
  if (canList.value && isPublic.value) {
    let back: string | null = null
    try {
      back = returnPath(sessionStorage.getItem(RETURN_KEY))
      sessionStorage.removeItem(RETURN_KEY)
    } catch {
      // No storage: stay on the list.
    }
    if (back) {
      await navigateTo(back, { replace: true })
      return
    }
  }
  await loadList()
})
const refresh = loadList

const loadingText = computed(() => (tab.value === 'shared' ? 'Loading boards shared with you…' : tab.value === 'trash' ? 'Loading the trash…' : 'Loading boards…'))
const shownCount = computed(() => (tab.value === 'shared' ? sharedRows.value.length : rows.value.length))

/** The thumbnail of a board by key; `v` (the head) makes a new revision a new image. */
const thumb = (key: string, v?: number) => `/api/boards/${encodeURIComponent(key)}/thumbnail${v ? `?v=${v}` : ''}`
/** A thumbnail that does not load (a link password not entered yet) is hidden, not broken. */
function hideBroken(ev: Event) {
  (ev.target as HTMLImageElement).style.visibility = 'hidden'
}

const VISIBILITY: Record<Visibility, { label: string, color: 'neutral' | 'info' | 'warning', icon: string }> = {
  view: { label: 'Link: view', color: 'neutral', icon: 'i-lucide-eye' },
  edit: { label: 'Link: edit', color: 'info', icon: 'i-lucide-pencil' },
  private: { label: 'Private', color: 'warning', icon: 'i-lucide-lock' }
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

// Duplicate (my board) and fork (a shared one): a new board of mine.
const busy = ref<string | null>(null)
async function copyOf(key: string, name: string, own: boolean) {
  if (busy.value) return
  busy.value = key
  try {
    const { id } = await $fetch<{ id: string }>(`/api/boards/${encodeURIComponent(key)}/fork`, { method: 'POST' })
    if (own) {
      toast.add({ title: `Duplicated as ${name} (copy)`, color: 'success', icon: 'i-lucide-check' })
      await refresh()
    } else {
      await navigateTo(`/b/${id}`)
    }
  } catch (e) {
    failToast(e)
  } finally {
    busy.value = null
  }
}

// The trash.
async function post(b: BoardRow, action: 'trash' | 'untrash', done: string) {
  if (busy.value) return
  busy.value = b.id
  try {
    await $fetch(`/api/boards/${b.id}/${action}`, { method: 'POST' })
    toast.add({ title: done, color: 'success', icon: 'i-lucide-check' })
    await refresh()
  } catch (e) {
    failToast(e)
  } finally {
    busy.value = null
  }
}
const toTrash = (b: BoardRow) => post(b, 'trash', `${b.name} moved to the trash. It is deleted for good after ${TRASH_DAYS} days.`)
const restore = (b: BoardRow) => post(b, 'untrash', `${b.name} restored`)

const deleting = ref<BoardRow | null>(null)
const confirmName = ref('')
const deleteErrors = ref<string[]>([])
function openDelete(b: BoardRow) {
  deleting.value = b
  confirmName.value = ''
  deleteErrors.value = []
}
async function deleteForGood() {
  const b = deleting.value
  if (!b || confirmName.value !== b.name) return
  try {
    await $fetch(`/api/boards/${b.id}`, { method: 'DELETE', body: { confirm: confirmName.value } })
    deleting.value = null
    toast.add({ title: `${b.name} deleted for good`, color: 'success', icon: 'i-lucide-check' })
    await refresh()
  } catch (e) {
    deleteErrors.value = errorsOf(e)
  }
}

// Share (public mode, my boards).
const sharing = ref<BoardRow | null>(null)
watch(sharing, (s, was) => {
  // Closed: the visibility badge may have changed.
  if (!s && was) void refresh()
})

/** A board of mine's actions besides Open and Share. */
const more = (b: BoardRow) => [[
  { label: 'Rename', icon: 'i-lucide-text-cursor-input', onSelect: () => openRename(b) },
  { label: 'Duplicate', icon: 'i-lucide-copy', onSelect: () => void copyOf(b.id, b.name, true) },
  // An attachment: the browser saves it and stays on this page.
  { label: 'Download', icon: 'i-lucide-download', onSelect: () => window.location.assign(`/api/boards/${b.id}/download`) }
], [
  { label: 'Move to trash', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => void toTrash(b) }
]]
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
        {{ signedOut ? 'WireBender' : 'Boards' }}
      </h1>
      <div class="ml-auto flex items-center gap-2">
        <template v-if="canList">
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
        </template>
        <AccountMenu
          v-if="isPublic && user"
          :user="user"
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

    <p
      v-if="!me && meFailed"
      class="text-error"
    >
      Cannot reach the WireBender server.
    </p>
    <p
      v-else-if="!me"
      class="text-muted"
    >
      Loading…
    </p>

    <section
      v-else-if="signedOut"
      class="mx-auto flex w-full max-w-md flex-col gap-4 py-8"
    >
      <h2 class="text-lg font-semibold">
        Lay out stripboard and perfboard circuits, check them, and share them.
      </h2>
      <p class="text-sm text-muted">
        Sign in to keep your boards here, edit them from any device, and share a link with
        others. Someone sent you a link? Open it: you don't need an account to look.
      </p>
      <SignInButtons :providers="me.providers" />
    </section>

    <template v-else>
      <UTabs
        v-model="tab"
        :items="TABS"
        :content="false"
        variant="link"
      />

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
        v-if="listStatus === 'pending' || listStatus === 'idle'"
        class="text-muted"
      >
        {{ loadingText }}
      </p>
      <p
        v-else-if="listStatus === 'error'"
        class="text-error"
      >
        Cannot reach the WireBender server.
      </p>
      <p
        v-else-if="!shownCount"
        class="text-muted"
      >
        {{ EMPTY[tab] }}
      </p>

      <ul
        v-else-if="tab === 'shared'"
        class="divide-y divide-default border-y border-default"
      >
        <li
          v-for="s in sharedRows"
          :key="s.key"
          class="flex items-center gap-3 py-2"
        >
          <img
            :src="thumb(s.key)"
            alt=""
            width="64"
            height="48"
            loading="lazy"
            class="h-12 w-16 shrink-0 rounded border border-default bg-elevated object-contain"
            @error="hideBroken"
          >
          <div class="min-w-0 flex-1">
            <NuxtLink
              :to="`/b/${s.key}`"
              class="block truncate font-medium hover:underline"
            >
              {{ s.name }}
            </NuxtLink>
            <p class="truncate text-sm text-muted">
              by {{ s.owner }} · opened {{ when(s.lastOpened) }}
            </p>
          </div>
          <UBadge
            variant="subtle"
            :color="s.role === 'edit' ? 'info' : 'neutral'"
            :label="s.role === 'edit' ? 'Can edit' : 'Can view'"
            class="max-sm:hidden"
          />
          <div class="flex shrink-0 gap-1">
            <UButton
              size="xs"
              label="Open"
              :to="`/b/${s.key}`"
            />
            <UButton
              size="xs"
              variant="outline"
              icon="i-lucide-git-fork"
              label="Fork"
              :loading="busy === s.key"
              @click="copyOf(s.key, s.name, false)"
            />
          </div>
        </li>
      </ul>

      <ul
        v-else-if="tab === 'trash'"
        class="divide-y divide-default border-y border-default"
      >
        <li
          v-for="b in rows"
          :key="b.id"
          class="flex items-center gap-3 py-2"
        >
          <img
            :src="thumb(b.id, b.head)"
            alt=""
            width="64"
            height="48"
            loading="lazy"
            class="h-12 w-16 shrink-0 rounded border border-default bg-elevated object-contain opacity-60"
            @error="hideBroken"
          >
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium">
              {{ b.name }}
            </p>
            <p class="truncate text-sm text-muted">
              Trashed {{ when(b.trashedAt!) }} · deleted for good on {{ day(b.trashedAt! + TRASH_DAYS * DAY_MS) }}
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <UButton
              size="xs"
              variant="outline"
              icon="i-lucide-undo-2"
              label="Restore"
              :loading="busy === b.id"
              @click="restore(b)"
            />
            <UButton
              size="xs"
              variant="ghost"
              color="error"
              icon="i-lucide-trash"
              label="Delete for good"
              @click="openDelete(b)"
            />
          </div>
        </li>
      </ul>

      <ul
        v-else
        class="divide-y divide-default border-y border-default"
      >
        <li
          v-for="b in rows"
          :key="b.id"
          class="flex items-center gap-3 py-2"
        >
          <NuxtLink
            :to="`/b/${b.id}`"
            class="shrink-0"
            tabindex="-1"
            aria-hidden="true"
          >
            <img
              :src="thumb(b.id, b.head)"
              alt=""
              width="64"
              height="48"
              loading="lazy"
              class="h-12 w-16 rounded border border-default bg-elevated object-contain"
              @error="hideBroken"
            >
          </NuxtLink>
          <div class="min-w-0 flex-1">
            <NuxtLink
              :to="`/b/${b.id}`"
              class="block truncate font-medium hover:underline"
            >
              {{ b.name }}
            </NuxtLink>
            <p class="truncate text-sm text-muted">
              {{ when(b.updatedAt) }} · {{ b.author }} · rev {{ b.head }}
            </p>
          </div>
          <div
            v-if="isPublic"
            class="flex shrink-0 items-center gap-1 max-sm:hidden"
          >
            <UBadge
              variant="subtle"
              :color="VISIBILITY[b.visibility].color"
              :icon="VISIBILITY[b.visibility].icon"
              :label="VISIBILITY[b.visibility].label"
            />
            <UBadge
              v-if="b.hasPassword && b.visibility !== 'private'"
              variant="subtle"
              color="neutral"
              icon="i-lucide-key-round"
              label="Password"
            />
          </div>
          <div class="flex shrink-0 gap-1">
            <UButton
              size="xs"
              label="Open"
              :to="`/b/${b.id}`"
            />
            <UButton
              v-if="isPublic"
              size="xs"
              variant="outline"
              icon="i-lucide-share-2"
              label="Share"
              @click="sharing = b"
            />
            <UDropdownMenu
              :items="more(b)"
              :content="{ align: 'end' }"
            >
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-ellipsis"
                :loading="busy === b.id"
                :aria-label="`More for ${b.name}`"
              />
            </UDropdownMenu>
          </div>
        </li>
      </ul>
    </template>

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

    <UModal
      :open="deleting !== null"
      title="Delete for good"
      :description="deleting ? `${deleting.name} and its whole history are deleted now. This cannot be undone.` : undefined"
      @update:open="(o: boolean) => o || (deleting = null)"
    >
      <template #body>
        <form
          id="delete-board"
          class="space-y-3"
          @submit.prevent="deleteForGood"
        >
          <UFormField :label="`Type the board's name, ${deleting?.name}, to delete it`">
            <UInput
              v-model="confirmName"
              class="w-full"
              autocomplete="off"
              autofocus
            />
          </UFormField>
          <ul
            v-if="deleteErrors.length"
            class="font-mono text-xs text-error"
          >
            <li
              v-for="e in deleteErrors"
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
          @click="deleting = null"
        />
        <UButton
          type="submit"
          form="delete-board"
          color="error"
          label="Delete for good"
          :disabled="!deleting || confirmName !== deleting.name"
        />
      </template>
    </UModal>

    <ShareDialog
      v-if="sharing"
      :open="true"
      :board-id="sharing.id"
      @update:open="(o: boolean) => o || (sharing = null)"
    />
  </div>
</template>
