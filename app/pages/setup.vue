<script setup lang="ts">
// First run in public mode (spec §3): the setup code from the server's log, then a sign-in.
// The account that signs in becomes the admin and takes over this server's local boards.
// Already signed in, the code makes this account the admin at once (ruling R9).
useHead({ title: 'Setup · WireBender' })

const { me, load } = useMe()
onMounted(() => void load(true))

// A sign-in after an accepted code that did not make this account the admin (oauth.ts).
const route = useRoute()
const refused = computed(() => route.query.error === 'done')

const code = ref('')
const sending = ref(false)
const error = ref<string | null>(null)
/** The code was right: signed out, sign in next. */
const accepted = ref(false)
const done = ref(false)
const toast = useToast()

async function send() {
  error.value = null
  sending.value = true
  try {
    const r = await $fetch<{ ok: true, admin: boolean }>('/api/setup', { method: 'POST', body: { code: code.value } })
    if (r.admin) {
      await load(true)
      toast.add({ title: 'You are the admin of this server', color: 'success' })
      await navigateTo('/admin')
      return
    }
    accepted.value = true
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    const data = (e as { data?: { error?: unknown } }).data
    if (status === 410) done.value = true
    else error.value = typeof data?.error === 'string' ? data.error : 'The code could not be checked. Try again.'
  } finally {
    sending.value = false
  }
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
        Setup
      </h1>
    </header>

    <p
      v-if="me?.mode === 'public' && refused && !accepted && !done"
      class="text-sm text-warning"
      role="alert"
    >
      You are signed in, but this account was not made the admin: either the server already
      has an admin, or it restarted and printed a new setup code after you entered yours. If
      there is a new code in the log, enter it below.
    </p>

    <p
      v-if="!me"
      class="text-sm text-muted"
    >
      Loading…
    </p>

    <template v-else-if="me.mode === 'local'">
      <p class="text-sm">
        This server runs in local mode: there is no setup and no admin to make.
      </p>
      <UButton
        to="/"
        label="Back to boards"
        variant="soft"
        class="self-start"
      />
    </template>

    <template v-else-if="done">
      <p class="text-sm">
        Setup is done: this server has an admin.
      </p>
      <UButton
        to="/"
        label="Back to boards"
        variant="soft"
        class="self-start"
      />
    </template>

    <template v-else-if="accepted">
      <p class="text-sm">
        Code accepted. Now sign in: the account you sign in with becomes the admin of this
        server, and takes over the boards made on it in local mode, with their history.
      </p>
      <SignInButtons :providers="me.providers" />
    </template>

    <form
      v-else
      class="space-y-3"
      @submit.prevent="send"
    >
      <p class="text-sm text-muted">
        When it starts with no admin, the server prints a setup code in its log. Enter it
        here to make the first admin.
        <template v-if="me.user">
          Your account, {{ me.user.name }}, becomes the admin.
        </template>
        <template v-else>
          You sign in next, and that account becomes the admin.
        </template>
      </p>
      <UFormField
        label="Setup code"
        :error="error ?? undefined"
      >
        <UInput
          v-model="code"
          class="w-full font-mono"
          placeholder="XXXX-XXXX-XXXX"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="20"
        />
      </UFormField>
      <UButton
        type="submit"
        label="Continue"
        :loading="sending"
        :disabled="!code.trim()"
      />
    </form>
  </div>
</template>
