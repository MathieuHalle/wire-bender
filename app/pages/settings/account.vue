<script setup lang="ts">
// The Account tab: your name, the providers you sign in with, your boards as a download.
// In local mode there is nothing to sign in to.
import { signInError as signInErrorText } from '~/utils/nav'
import { saveZip } from '~/utils/download'
import type { Me, Provider } from '~/composables/useMe'

useHead({ title: 'Account · WireBender' })

const LABEL: Record<Provider, string> = { github: 'GitHub', google: 'Google' }
const route = useRoute()
const signInError = computed(() => signInErrorText(typeof route.query.error === 'string' ? route.query.error : null))

const { me } = useMe()
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
    const data = (e as { data?: { errors?: unknown, error?: unknown } }).data
    nameError.value = Array.isArray(data?.errors) ? data.errors.map(String).join(' ') : typeof data?.error === 'string' ? data.error : (e as Error).message
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
  </div>
</template>
