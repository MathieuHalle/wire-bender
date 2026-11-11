<script setup lang="ts">
import { RETURN_KEY, returnPath } from '~/utils/boardView'
import { homeTarget } from '~/utils/nav'

// `/` sends a signed-in user (or local mode) on: back to the page a sign-in started from,
// else the boards. Signed out in public mode: a short intro with the sign-in buttons.
const { me, failed: meFailed, load: loadMe } = useMe()
/** Public mode, nobody signed in: the intro. */
const signedOut = ref(false)

onMounted(async () => {
  const now = await loadMe()
  if (!now) return
  let stored: string | null = null
  try {
    stored = sessionStorage.getItem(RETURN_KEY)
    sessionStorage.removeItem(RETURN_KEY)
  } catch {
    // No storage: go to the boards.
  }
  const to = homeTarget(now, returnPath(stored))
  if (to) {
    await navigateTo(to, { replace: true })
    return
  }
  signedOut.value = true
  setPageLayout('auth')
})
</script>

<template>
  <div>
    <p
      v-if="!me && meFailed"
      class="p-4 text-error"
    >
      Cannot reach the WireBender server.
    </p>
    <p
      v-else-if="!me || !signedOut"
      class="p-4 text-muted"
    >
      Loading…
    </p>

    <section
      v-else
      class="flex w-full flex-col gap-4"
    >
      <h1 class="text-lg font-semibold">
        Lay out stripboard and perfboard circuits, check them, and share them.
      </h1>
      <p class="text-sm text-muted">
        Sign in to keep your boards here, edit them from any device, and share a link with
        others. Someone sent you a link? Open it: you don't need an account to look.
      </p>
      <SignInButtons :providers="me.providers" />
    </section>
  </div>
</template>
