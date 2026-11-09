<script setup lang="ts">
// The account page: sign in, or your name, the providers you sign in with, and sign out.
// In local mode there is nothing to sign in to. A deleted account waiting for its purge
// sees only this page (ruling R1); restoring it comes with account deletion.
useHead({ title: 'Account · WireBender' })

type Provider = 'github' | 'google'
interface Me {
  mode: 'local' | 'public'
  user: { id: string, name: string, avatar: string | null, isAdmin: boolean, isPremium: boolean, providers: Provider[], deletedAt: number | null } | null
  providers: Provider[]
}

const LABEL: Record<Provider, string> = { github: 'GitHub', google: 'Google' }
const ERRORS: Record<string, string> = {
  taken: 'That sign-in is already used by another WireBender account, so it was not linked.',
  suspended: 'This account is suspended.',
  deleted: 'This account is deleted.',
  oauth: 'Sign-in did not finish. Try again.'
}

const route = useRoute()
const errorCode = computed(() => typeof route.query.error === 'string' ? route.query.error : null)
const signInError = computed(() => errorCode.value ? ERRORS[errorCode.value] ?? ERRORS.oauth : null)

// Loaded on the client only, like the board list: who is signed in is per browser.
const { data: me, status, refresh } = useFetch<Me>('/api/me', { server: false })

const user = computed(() => me.value?.user ?? null)
const toLink = computed(() => (me.value?.providers ?? []).filter(p => !user.value?.providers.includes(p)))
const DAY_MS = 24 * 3600 * 1000
const purgeOn = computed(() => user.value?.deletedAt
  ? new Date(user.value.deletedAt + 30 * DAY_MS).toLocaleDateString(undefined, { dateStyle: 'long' })
  : null)

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

async function signOut() {
  await $fetch('/api/_auth/session', { method: 'DELETE' })
  await refresh()
  await navigateTo('/account', { replace: true })
}
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-5 p-6">
    <header class="flex items-center gap-3">
      <NuxtLink
        to="/"
        aria-label="Boards"
      >
        <img
          src="/icon.svg"
          alt=""
          width="28"
          height="28"
        >
      </NuxtLink>
      <h1 class="text-xl font-semibold">
        Account
      </h1>
    </header>

    <p
      v-if="signInError"
      class="text-sm text-error"
      role="alert"
    >
      {{ signInError }}
    </p>

    <p
      v-if="status === 'pending' && !me"
      class="text-sm text-muted"
    >
      Loading…
    </p>

    <template v-else-if="me?.mode === 'local'">
      <p class="text-sm">
        This server runs in local mode: there is nothing to sign in to.
      </p>
      <p class="text-sm text-muted">
        This computer and the devices paired with it can open and edit every board. To let
        others in, run WireBender in public mode with GitHub or Google sign-in.
      </p>
      <TokensPanel />
      <UButton
        icon="i-lucide-download"
        label="Download all my boards"
        variant="outline"
        class="self-start"
        :loading="exporting"
        @click="downloadAll"
      />
      <UButton
        to="/"
        label="Back to boards"
        variant="soft"
        class="self-start"
      />
    </template>

    <template v-else-if="user?.deletedAt">
      <p class="text-sm">
        You are signed in as <strong>{{ user.name }}</strong>, whose account is deleted. It
        will be removed for good on {{ purgeOn }}, with its boards. Until then it can be restored.
      </p>
      <UButton
        label="Sign out"
        color="neutral"
        variant="outline"
        class="self-start"
        @click="signOut"
      />
    </template>

    <template v-else-if="user">
      <div class="flex items-center gap-3">
        <UAvatar
          :src="user.avatar ?? undefined"
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

      <TokensPanel />

      <UButton
        icon="i-lucide-download"
        label="Download all my boards"
        variant="outline"
        class="self-start"
        :loading="exporting"
        @click="downloadAll"
      />

      <UButton
        label="Sign out"
        color="neutral"
        variant="outline"
        class="self-start"
        @click="signOut"
      />
    </template>

    <template v-else-if="me">
      <p class="text-sm text-muted">
        Sign in to keep your boards and edit boards shared with you. A first sign-in makes a
        new account.
      </p>
      <SignInButtons :providers="me.providers" />
    </template>

    <NuxtLink
      to="/api"
      class="text-sm text-muted underline"
    >
      API docs
    </NuxtLink>
  </div>
</template>
