<script setup lang="ts">
// The Sharing tab: the board's link (with Copy), who the link lets in (View / Edit /
// Private), a link password (which the owner can show again: GET .../sharing/password), "New link", and the signed-in people who opened the link. The
// owner's only, in public mode (GET/PATCH /api/boards/:id/sharing). Private and passwords
// need premium; losing it keeps them, and they can still be removed. Every change closes
// the link's open sessions, which reconnect with the new access.
import { relativeTime } from '~/utils/history'

const props = defineProps<{
  boardId: string
  /** The tab is on show: it loads then, and again when who is on the board changes. */
  active: boolean
  /** How many are on the board live; a change reloads the list's "here now". */
  peerCount: number
}>()

type Visibility = 'view' | 'edit' | 'private'
interface Person { name: string, lastOpened: number, current: boolean, here: boolean }
interface Sharing { visibility: Visibility, hasPassword: boolean, link: string, canUsePremium: boolean, people: Person[] }

const sharing = ref<Sharing | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)
const password = ref('')
const confirmingNewLink = ref(false)
const now = ref(Date.now())
const toast = useToast()

const url = computed(() => `/api/boards/${encodeURIComponent(props.boardId)}/sharing`)

/** The server's reason for a refused request, else the fetch error. */
function reasonOf(e: unknown): string {
  const data = (e as { data?: { error?: unknown, errors?: unknown } }).data
  if (typeof data?.error === 'string') return data.error
  if (Array.isArray(data?.errors) && typeof data.errors[0] === 'string') return data.errors[0]
  return (e as Error).message
}

let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  try {
    const s = await $fetch<Sharing>(url.value)
    if (seq !== loadSeq) return
    sharing.value = s
    error.value = null
    now.value = Date.now()
  } catch (e) {
    if (seq !== loadSeq) return
    sharing.value = null
    error.value = `Could not load the sharing settings: ${reasonOf(e)}`
  }
}
watch(() => props.boardId, () => {
  sharing.value = null
  password.value = ''
  confirmingNewLink.value = false
})
watch(() => [props.active, props.boardId, props.peerCount] as const, ([active]) => {
  if (active) void load()
}, { immediate: true })

async function change(body: { visibility?: Visibility, password?: string | null }, done: string) {
  if (busy.value) return
  busy.value = true
  try {
    sharing.value = await $fetch<Sharing>(url.value, { method: 'PATCH', body })
    toast.add({ title: done, color: 'success', icon: 'i-lucide-check' })
    return true
  } catch (e) {
    toast.add({ title: reasonOf(e), color: 'error', icon: 'i-lucide-ban' })
    return false
  } finally {
    busy.value = false
  }
}

const LABEL: Record<Visibility, string> = { view: 'View', edit: 'Edit', private: 'Private' }
/** Private is offered with premium, or when the board is private already (kept after premium lapsed). */
const privateAllowed = computed(() => !!sharing.value && (sharing.value.canUsePremium || sharing.value.visibility === 'private'))
const items = computed(() => [
  { value: 'view', label: 'View', description: 'Anyone with the link can look, check and download.' },
  { value: 'edit', label: 'Edit', description: 'Anyone signed in with the link can edit. Signed-out visitors can look.' },
  { value: 'private', label: 'Private', description: 'Only you. The link does not open.', disabled: !privateAllowed.value }
])
/**
 * The radio group's own value: a pick is sent, and a refused one (403, a limit) snaps back
 * to the saved value. A computed over the saved value would leave the radio on the refused
 * pick, since the group keeps its own state when its model does not change.
 */
const visibility = ref<Visibility | undefined>()
watch(() => sharing.value?.visibility, (v) => {
  visibility.value = v
}, { immediate: true })
watch(visibility, async (v) => {
  const saved = sharing.value?.visibility
  if (!v || !saved || v === saved) return
  if (!await change({ visibility: v }, `The link now gives: ${LABEL[v]}`)) visibility.value = sharing.value?.visibility
})

const passwordLength = computed(() => [...password.value].length)
const passwordOk = computed(() => passwordLength.value >= 4 && passwordLength.value <= 100)
async function setPassword() {
  if (!passwordOk.value) return
  if (await change({ password: password.value }, 'Link password set')) {
    password.value = ''
    shown.value = undefined
  }
}
async function removePassword() {
  if (await change({ password: null }, 'Link password removed')) shown.value = undefined
}

/** The link password on show: undefined while hidden, null when it can't be shown (set before it was kept). */
const shown = ref<string | null | undefined>()
watch(() => props.boardId, () => {
  shown.value = undefined
})
async function showPassword() {
  try {
    shown.value = (await $fetch<{ password: string | null }>(`${url.value}/password`)).password
  } catch (e) {
    toast.add({ title: `Could not show the password: ${reasonOf(e)}`, color: 'error', icon: 'i-lucide-ban' })
  }
}

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: done, color: 'success', icon: 'i-lucide-check' })
  } catch {
    toast.add({ title: 'Could not copy. Select it and copy it by hand.', color: 'warning', icon: 'i-lucide-ban' })
  }
}
const copy = () => sharing.value && copyText(sharing.value.link, 'Link copied')

async function newLink() {
  if (busy.value) return
  busy.value = true
  try {
    await $fetch<{ link: string }>(`${url.value}/regenerate`, { method: 'POST' })
    confirmingNewLink.value = false
    toast.add({ title: 'New link made. The old one no longer works.', color: 'success', icon: 'i-lucide-check' })
    // Everyone on the list is now on the old link: reload it with the new link.
    await load()
  } catch (e) {
    toast.add({ title: reasonOf(e), color: 'error', icon: 'i-lucide-ban' })
  } finally {
    busy.value = false
  }
}

/** What a person on the list can do now: the link's setting, or why they can't get in. */
function accessOf(p: Person, v: Visibility): string {
  if (!p.current) return 'old link'
  if (v === 'private') return 'no access'
  return LABEL[v]
}
</script>

<template>
  <div class="flex flex-col gap-5 text-sm">
    <p
      v-if="error"
      class="text-error"
    >
      {{ error }}
    </p>
    <p
      v-else-if="!sharing"
      class="text-muted"
    >
      Loading…
    </p>
    <template v-else>
      <UFormField label="Link">
        <div class="flex gap-2">
          <UInput
            :model-value="sharing.link"
            class="w-full font-mono"
            readonly
            aria-label="Share link"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <UButton
            variant="outline"
            icon="i-lucide-copy"
            label="Copy"
            @click="copy"
          />
        </div>
      </UFormField>

      <URadioGroup
        v-model="visibility"
        legend="The link gives"
        :items="items"
        :disabled="busy"
      >
        <template #label="{ item }">
          <span class="inline-flex items-center gap-2">
            {{ item.label }}
            <UBadge
              v-if="item.value === 'private' && !sharing.canUsePremium"
              size="sm"
              variant="subtle"
              color="neutral"
              label="Premium"
            />
          </span>
        </template>
      </URadioGroup>

      <div
        v-if="sharing.hasPassword"
        class="flex flex-col gap-1"
      >
        <span class="text-xs font-medium text-muted">The link asks for a password</span>
        <div class="flex items-center gap-1">
          <span
            class="min-w-0 flex-1 truncate font-mono"
            :class="{ 'text-muted': shown === undefined }"
            data-testid="link-password"
          >{{ shown ?? '••••••••' }}</span>
          <UButton
            type="button"
            size="sm"
            variant="ghost"
            color="neutral"
            :icon="shown ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            :label="shown ? 'Hide' : 'Show'"
            :disabled="busy || shown === null"
            @click="shown ? (shown = undefined) : showPassword()"
          />
          <UButton
            v-if="shown"
            type="button"
            size="sm"
            variant="ghost"
            color="neutral"
            icon="i-lucide-copy"
            label="Copy"
            @click="copyText(shown, 'Password copied')"
          />
          <UButton
            type="button"
            size="sm"
            variant="ghost"
            color="error"
            label="Remove"
            :disabled="busy"
            @click="removePassword"
          />
        </div>
        <p
          v-if="shown === null"
          class="text-xs text-muted"
        >
          This password was set before passwords could be shown again. Set it again to see it here.
        </p>
      </div>

      <form
        v-if="sharing.canUsePremium"
        class="space-y-2"
        @submit.prevent="setPassword"
      >
        <UFormField
          :label="sharing.hasPassword ? 'New link password' : 'Link password'"
          :help="sharing.hasPassword ? 'Setting a new one asks everyone again.' : 'Optional: visitors must enter it to open the link. 4 to 100 characters.'"
        >
          <div class="flex gap-2">
            <UInput
              v-model="password"
              type="password"
              class="w-full"
              autocomplete="new-password"
              maxlength="400"
              :placeholder="sharing.hasPassword ? 'New password' : 'Password'"
            />
            <UButton
              type="submit"
              :label="sharing.hasPassword ? 'Change' : 'Set'"
              :disabled="!passwordOk || busy"
            />
          </div>
        </UFormField>
      </form>

      <UAlert
        v-if="confirmingNewLink"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="The current link will stop working."
        description="Anyone using it is disconnected and needs the new link."
        :actions="[
          { label: 'Cancel', color: 'neutral', variant: 'outline', onClick: () => { confirmingNewLink = false } },
          { label: 'Make a new link', color: 'warning', loading: busy, onClick: newLink }
        ]"
      />
      <UButton
        v-else
        class="self-start"
        variant="outline"
        icon="i-lucide-refresh-cw"
        label="New link"
        :disabled="busy"
        @click="confirmingNewLink = true"
      />

      <section class="flex flex-col gap-1">
        <h3 class="text-xs font-medium text-muted">
          People who opened the link<template v-if="sharing.people.length">
            · {{ sharing.people.length }}
          </template>
        </h3>
        <p
          v-if="!sharing.people.length"
          class="text-muted"
        >
          No one signed in has opened it yet.
        </p>
        <ul v-else>
          <li
            v-for="(p, i) in sharing.people"
            :key="i"
            class="flex items-center gap-2 border-t border-default py-1"
            :class="{ 'opacity-50': !p.current }"
          >
            <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
            <span
              v-if="p.here"
              class="size-2 shrink-0 rounded-full bg-success"
              aria-hidden="true"
            />
            <span class="shrink-0 text-xs text-muted">
              {{ accessOf(p, sharing.visibility) }} · {{ p.here ? 'here now' : relativeTime(p.lastOpened, now) }}
            </span>
          </li>
        </ul>
        <p class="text-xs text-muted">
          People who aren't signed in can also open the link, and don't show here.
        </p>
      </section>
    </template>
  </div>
</template>
