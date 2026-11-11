<script setup lang="ts">
import { RETURN_KEY, returnEntry } from '~/utils/boardView'

// One button per sign-in provider the server has configured (GET /api/me `providers`).
// Each is a full page load: the provider's page, then back to /auth/<provider>.
type Provider = 'github' | 'google'

const props = withDefaults(defineProps<{
  providers: Provider[]
  /** "Sign in with" or, from the account page, "Link". */
  verb?: string
  /** A board page to come back to once signed in (the sign-in itself ends on /). */
  returnTo?: string
}>(), { verb: 'Sign in with', returnTo: undefined })

/** Remembered for this tab only; `/` sends the user on. */
function remember() {
  if (!props.returnTo) return
  try {
    sessionStorage.setItem(RETURN_KEY, returnEntry(props.returnTo))
  } catch {
    // No storage (a private window): the user lands on the boards.
  }
}

const LOOK: Record<Provider, { label: string, icon: string }> = {
  github: { label: 'GitHub', icon: 'i-simple-icons-github' },
  google: { label: 'Google', icon: 'i-simple-icons-google' }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <UButton
      v-for="p in props.providers"
      :key="p"
      :to="`/auth/${p}`"
      external
      block
      size="lg"
      color="neutral"
      variant="outline"
      :icon="LOOK[p].icon"
      :label="`${props.verb} ${LOOK[p].label}`"
      @click="remember"
    />
  </div>
</template>
