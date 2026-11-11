<script setup lang="ts">
// Signs out (public mode), then says so. Local mode has no sign-in: on to the boards.
definePageMeta({ layout: 'auth' })
useHead({ title: 'Signed out · WireBender' })

const { me, failed, load, signOut } = useMe()
const done = ref(false)

onMounted(async () => {
  const now = await load()
  if (!now) return
  if (now.mode === 'local') {
    await navigateTo('/boards', { replace: true })
    return
  }
  await signOut()
  done.value = true
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <p
      v-if="!done && failed && !me"
      class="text-sm text-error"
    >
      Cannot reach the WireBender server.
    </p>
    <p
      v-else-if="!done"
      class="text-sm text-muted"
    >
      Signing out…
    </p>
    <template v-else>
      <h1 class="text-lg font-semibold">
        Signed out.
      </h1>
      <div class="flex gap-2">
        <UButton
          to="/login"
          label="Sign in again"
        />
        <UButton
          to="/"
          label="Home"
          color="neutral"
          variant="outline"
        />
      </div>
    </template>
  </div>
</template>
