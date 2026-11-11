<script setup lang="ts">
// A deleted account waiting for its purge sees only this page: when it goes, and a way back.
definePageMeta({ layout: 'auth' })
useHead({ title: 'Account deleted · WireBender' })

const DAY_MS = 24 * 3600 * 1000
const { me, failed, load } = useMe()
const user = computed(() => me.value?.user ?? null)
const purgeOn = computed(() => user.value?.deletedAt
  ? new Date(user.value.deletedAt + 30 * DAY_MS).toLocaleDateString(undefined, { dateStyle: 'long' })
  : null)

onMounted(async () => {
  const now = await load()
  // Not a deleted account (signed out, local mode, or fine): nothing to restore.
  if (now && !now.user?.deletedAt) await navigateTo('/boards', { replace: true })
})

const restoring = ref(false)
const error = ref<string | null>(null)

async function restore() {
  error.value = null
  restoring.value = true
  try {
    await $fetch('/api/me/restore', { method: 'POST' })
    await load(true)
    await navigateTo('/', { replace: true })
  } catch (e) {
    const data = (e as { data?: { error?: unknown } }).data
    error.value = typeof data?.error === 'string' ? data.error : `Restore failed: ${(e as Error).message}`
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p
      v-if="!me && failed"
      class="text-sm text-error"
    >
      Cannot reach the WireBender server.
    </p>
    <p
      v-else-if="!user?.deletedAt"
      class="text-sm text-muted"
    >
      Loading…
    </p>
    <template v-else>
      <p class="text-sm">
        You are signed in as <strong>{{ user.name }}</strong>, whose account is deleted. It
        will be removed for good on {{ purgeOn }}, with its boards. Until then it can be restored.
      </p>
      <p
        v-if="error"
        class="text-sm text-error"
        role="alert"
      >
        {{ error }}
      </p>
      <div class="flex gap-2">
        <UButton
          label="Restore"
          :loading="restoring"
          @click="restore"
        />
        <UButton
          to="/logout"
          label="Sign out"
          color="neutral"
          variant="outline"
        />
      </div>
    </template>
  </div>
</template>
