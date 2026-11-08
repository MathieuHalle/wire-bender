<script setup lang="ts">
// Access tokens for scripts and AI tools (spec: step 3). The plaintext comes back once, from the create call.
interface TokenRow { id: string, name: string, prefix: string, createdAt: number, lastUsedAt: number | null }

const { data: tokens, refresh } = useFetch<TokenRow[]>('/api/tokens', { server: false })

const name = ref('')
const creating = ref(false)
const error = ref<string | null>(null)
const fresh = ref<{ name: string, token: string } | null>(null)
const confirming = ref<string | null>(null)
const toast = useToast()

// R8: in local mode a paired device cannot make tokens; only this computer can.
const { me, load } = useMe()
const onDevice = ref(false)
onMounted(async () => {
  if ((await load())?.mode !== 'local') return
  try {
    onDevice.value = (await $fetch<{ paired: boolean }>('/api/devices/me')).paired
  } catch {
    // The server's own refusal is shown if Create is tried.
  }
})

function message(e: unknown): string {
  const data = (e as { data?: { errors?: unknown, error?: unknown } }).data
  return Array.isArray(data?.errors) ? data.errors.map(String).join(' ') : typeof data?.error === 'string' ? data.error : (e as Error).message
}

async function create() {
  error.value = null
  creating.value = true
  try {
    const r = await $fetch<{ name: string, token: string }>('/api/tokens', { method: 'POST', body: { name: name.value } })
    fresh.value = { name: r.name, token: r.token }
    name.value = ''
    await refresh()
  } catch (e) {
    error.value = message(e)
  } finally {
    creating.value = false
  }
}

async function copy() {
  if (!fresh.value) return
  try {
    await navigator.clipboard.writeText(fresh.value.token)
    toast.add({ title: 'Copied', color: 'success' })
  } catch {
    toast.add({ title: 'Could not copy. Select the token and copy it by hand.', color: 'error' })
  }
}

async function revoke(id: string) {
  error.value = null
  try {
    await $fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
    confirming.value = null
    await refresh()
  } catch (e) {
    error.value = message(e)
  }
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <section class="space-y-3">
    <h2 class="text-sm font-medium">
      Tokens
    </h2>
    <p class="text-sm text-muted">
      A token lets a script or an AI tool act as you on your boards.
      <NuxtLink
        to="/api"
        class="underline"
      >
        How to use one
      </NuxtLink>
    </p>

    <p
      v-if="onDevice && me?.mode === 'local'"
      class="text-sm"
    >
      Create tokens on this computer.
    </p>
    <form
      v-else
      class="flex items-start gap-2"
      @submit.prevent="create"
    >
      <UInput
        v-model="name"
        class="flex-1"
        placeholder="Name, e.g. Claude on my laptop"
        maxlength="60"
        aria-label="Token name"
      />
      <UButton
        type="submit"
        label="Create"
        :loading="creating"
        :disabled="!name.trim()"
      />
    </form>

    <p
      v-if="error"
      class="text-sm text-error"
      role="alert"
    >
      {{ error }}
    </p>

    <div
      v-if="fresh"
      class="space-y-2 rounded-md border border-default p-3"
    >
      <p class="text-sm">
        Token <strong>{{ fresh.name }}</strong>
      </p>
      <div class="flex gap-2">
        <UInput
          :model-value="fresh.token"
          readonly
          class="flex-1"
          aria-label="New token"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <UButton
          label="Copy"
          variant="soft"
          @click="copy"
        />
      </div>
      <p class="text-sm text-muted">
        This token is shown only now. Store it somewhere safe.
      </p>
      <UButton
        label="Done"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="fresh = null"
      />
    </div>

    <p
      v-if="tokens && !tokens.length"
      class="text-sm text-muted"
    >
      No tokens yet.
    </p>
    <ul
      v-if="tokens?.length"
      class="divide-y divide-default"
    >
      <li
        v-for="t in tokens"
        :key="t.id"
        class="flex items-center justify-between gap-3 py-2"
      >
        <div class="min-w-0 text-sm">
          <p class="truncate font-medium">
            {{ t.name }}
          </p>
          <p class="text-muted">
            <code>wb_{{ t.prefix }}…</code>
          </p>
          <p class="text-xs text-muted">
            Created {{ when(t.createdAt) }} · Last used {{ t.lastUsedAt ? when(t.lastUsedAt) : 'never' }}
          </p>
        </div>
        <div
          v-if="confirming === t.id"
          class="flex shrink-0 items-center gap-1"
        >
          <UButton
            label="Revoke"
            size="xs"
            color="error"
            @click="revoke(t.id)"
          />
          <UButton
            label="Keep"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="confirming = null"
          />
        </div>
        <UButton
          v-else
          label="Revoke"
          size="xs"
          color="neutral"
          variant="outline"
          @click="confirming = t.id"
        />
      </li>
    </ul>
  </section>
</template>
