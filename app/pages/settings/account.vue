<script setup lang="ts">
// The Account tab: your name, the providers you sign in with, your boards as a download,
// and (public mode) deleting the account. In local mode there is nothing to sign in to.
import { signInError as signInErrorText } from '~/utils/nav'
import { saveZip } from '~/utils/download'
import type { Me, Provider } from '~/composables/useMe'

useHead({ title: 'Account · WireBender' })

const LABEL: Record<Provider, string> = { github: 'GitHub', google: 'Google' }
const route = useRoute()
const signInError = computed(() => signInErrorText(typeof route.query.error === 'string' ? route.query.error : null))

const { me, load } = useMe()
const user = computed(() => me.value?.user ?? null)
const toLink = computed(() => (me.value?.providers ?? []).filter(p => !user.value?.providers.includes(p)))

const name = ref('')
watch(user, (u) => {
  name.value = u?.name ?? ''
}, { immediate: true })
const saving = ref(false)
const nameError = ref<string | null>(null)
const toast = useToast()

async function saveName() {
  nameError.value = null
  saving.value = true
  try {
    me.value = await $fetch<Me>('/api/me', { method: 'PATCH', body: { name: name.value } })
    toast.add({ title: 'Name saved', color: 'success' })
  } catch (e) {
    nameError.value = errorsOf(e).join(' ')
  } finally {
    saving.value = false
  }
}

const exporting = ref(false)
async function downloadAll() {
  exporting.value = true
  const refused = await saveZip('/api/me/export', 'wirebender-boards.zip')
  exporting.value = false
  toast.add(refused
    ? { title: refused, color: 'error', icon: 'i-lucide-ban' }
    : { title: 'Download started', color: 'success', icon: 'i-lucide-check' })
}

// Deleting is restorable for 30 days (spec §3): signing in again offers Restore.
const confirmDelete = ref(false)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
function openDelete() {
  deleteError.value = null
  confirmDelete.value = true
}
async function deleteAccount() {
  deleteError.value = null
  deleting.value = true
  try {
    await $fetch('/api/me', { method: 'DELETE' })
    await load(true)
    await navigateTo('/account/goodbye', { replace: true })
  } catch (e) {
    deleteError.value = errorsOf(e).join(' ')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex max-w-md flex-col gap-5">
    <UAlert
      v-if="signInError"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="signInError"
    />

    <template v-if="me?.mode === 'local'">
      <p class="text-sm">
        This server runs in local mode: there is nothing to sign in to.
      </p>
      <p class="text-sm text-muted">
        This computer and the devices paired with it can open and edit every board. To let
        others in, run WireBender in public mode with GitHub or Google sign-in.
      </p>
    </template>

    <template v-else-if="user">
      <div class="flex items-center gap-3">
        <UAvatar
          :src="safeAvatar(user.avatar)"
          :alt="user.name"
          size="lg"
        />
        <div class="min-w-0">
          <p class="truncate font-medium">
            {{ user.name }}
          </p>
          <p class="text-sm text-muted">
            Signed in with {{ user.providers.map(p => LABEL[p]).join(' and ') || 'no provider' }}
          </p>
        </div>
      </div>

      <form
        class="space-y-3"
        @submit.prevent="saveName"
      >
        <UFormField
          label="Name"
          help="Shown on your boards and in their history."
          :error="nameError ?? undefined"
        >
          <UInput
            v-model="name"
            class="w-full"
            maxlength="60"
          />
        </UFormField>
        <UButton
          type="submit"
          label="Save name"
          :loading="saving"
          :disabled="!name.trim() || name.trim() === user.name"
        />
      </form>

      <section
        v-if="toLink.length"
        class="space-y-2"
      >
        <h2 class="text-sm font-medium">
          Also sign in with
        </h2>
        <p class="text-sm text-muted">
          Link another provider to sign in to this same account with it.
        </p>
        <SignInButtons
          :providers="toLink"
          verb="Link"
        />
      </section>
    </template>

    <UButton
      v-if="me?.mode === 'local' || user"
      icon="i-lucide-download"
      label="Download all my boards"
      variant="outline"
      class="self-start"
      :loading="exporting"
      @click="downloadAll"
    />

    <section
      v-if="user"
      class="space-y-3 rounded-md border border-error/40 p-4"
      aria-labelledby="danger-zone"
    >
      <h2
        id="danger-zone"
        class="text-sm font-medium text-error"
      >
        Danger zone
      </h2>
      <p class="text-sm text-muted">
        Deleting your account signs you out. Sign back in within 30 days to restore it, with
        all your boards. After that, the account and its boards are removed for good.
      </p>
      <p
        v-if="user.isOnlyAdmin"
        class="text-sm"
      >
        You are the only admin, so you can't delete your account. Make another account admin first.
      </p>
      <UButton
        color="error"
        variant="outline"
        icon="i-lucide-user-x"
        label="Delete account"
        :disabled="user.isOnlyAdmin"
        @click="openDelete"
      />
    </section>

    <UModal
      v-model:open="confirmDelete"
      title="Delete your account?"
      description="You will be signed out now."
    >
      <template #body>
        <div class="space-y-3 text-sm">
          <p>
            Sign back in within 30 days to restore your account, and nothing is lost. After 30
            days, your account and all your boards are removed for good.
          </p>
          <p class="text-muted">
            Want a copy first? Use <strong>Download all my boards</strong> before you delete.
          </p>
          <p
            v-if="deleteError"
            class="text-error"
            role="alert"
          >
            {{ deleteError }}
          </p>
        </div>
      </template>
      <template #footer>
        <UButton
          variant="ghost"
          label="Cancel"
          @click="confirmDelete = false"
        />
        <UButton
          color="error"
          label="Delete account"
          :loading="deleting"
          @click="deleteAccount"
        />
      </template>
    </UModal>
  </div>
</template>
