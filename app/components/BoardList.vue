<script setup lang="ts">
import { saveZip } from '~/utils/download'
import type { BoardList } from '~/utils/nav'
import type { BoardRow, Visibility } from '~/composables/useBoardList'

// One board list: My boards (newest change first), Shared with me (public mode: boards opened
// by someone else's link, by their link id only) or Trash (Restore, or Delete for good after
// typing the name). The dashboard pages put it in their panel.
const props = defineProps<{ list: BoardList }>()

const { me, failed: meFailed } = useMe()
const toast = useToast()
const isPublic = computed(() => me.value?.mode === 'public')
const { rows, sharedRows, status: listStatus, refresh } = useBoardList(props.list)

const EMPTY: Record<BoardList, string> = {
  mine: 'No boards yet. Import a .wirebender.json or .wirebender.zip file or start a new board.',
  shared: 'Nothing shared with you yet. Boards you open from someone else\'s link show up here.',
  trash: 'The trash is empty.'
}
const TRASH_DAYS = 30
const DAY_MS = 24 * 3600 * 1000
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' })

const failToast = (e: unknown) => toast.add({ title: errorsOf(e).join(' '), color: 'error', icon: 'i-lucide-ban' })

const loadingText = computed(() => (props.list === 'shared' ? 'Loading boards shared with you…' : props.list === 'trash' ? 'Loading the trash…' : 'Loading boards…'))
const shownCount = computed(() => (props.list === 'shared' ? sharedRows.value.length : rows.value.length))

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

async function downloadBundle(b: BoardRow) {
  const refused = await saveZip(`/api/boards/${encodeURIComponent(b.id)}/bundle`, 'board.wirebender.zip')
  if (refused) toast.add({ title: refused, color: 'error', icon: 'i-lucide-ban' })
}

/** A board of mine's actions besides Open and Share. */
const more = (b: BoardRow) => [[
  { label: 'Rename', icon: 'i-lucide-text-cursor-input', onSelect: () => openRename(b) },
  { label: 'Duplicate', icon: 'i-lucide-copy', onSelect: () => void copyOf(b.id, b.name, true) },
  // An attachment: the browser saves it and stays on this page.
  { label: 'Board file', icon: 'i-lucide-download', onSelect: () => window.location.assign(`/api/boards/${b.id}/download`) },
  // The bundle can be big, so it goes through fetch, which can show a refusal as a toast.
  { label: 'Board with history', icon: 'i-lucide-history', onSelect: () => void downloadBundle(b) }
], [
  { label: 'Move to trash', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => void toTrash(b) }
]]
</script>

<template>
  <div class="flex flex-col gap-4">
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

    <template v-else>
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
        {{ EMPTY[list] }}
      </p>

      <ul
        v-else-if="list === 'shared'"
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
        v-else-if="list === 'trash'"
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
              :to="`/b/${b.id}#sharing`"
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
  </div>
</template>
