<script setup lang="ts">
import { needsLogin, signInError } from '~/utils/nav'

// Public mode, signed out: the sign-in buttons. Signed in, or local mode, there is nothing
// to sign in to: on to the boards. A board page's stored return path stays for `/` to use.
definePageMeta({ layout: 'auth' })
useHead({ title: 'Sign in · WireBender' })

const route = useRoute()
const error = computed(() => signInError(typeof route.query.error === 'string' ? route.query.error : null))

const { me, failed, load } = useMe()
onMounted(async () => {
  const now = await load()
  if (now && !needsLogin(now)) await navigateTo('/', { replace: true })
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 class="text-lg font-semibold">
      Sign in
    </h1>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="error"
    />
    <p
      v-if="!me && failed"
      class="text-sm text-error"
    >
      Cannot reach the WireBender server.
    </p>
    <p
      v-else-if="!me || !needsLogin(me)"
      class="text-sm text-muted"
    >
      Loading…
    </p>
    <SignInButtons
      v-else
      :providers="me.providers"
    />
  </div>
</template>
