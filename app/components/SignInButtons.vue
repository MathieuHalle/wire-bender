<script setup lang="ts">
// One button per sign-in provider the server has configured (GET /api/me `providers`).
// Each is a full page load: the provider's page, then back to /auth/<provider>.
type Provider = 'github' | 'google'

const props = withDefaults(defineProps<{
  providers: Provider[]
  /** "Sign in with" or, from the account page, "Link". */
  verb?: string
}>(), { verb: 'Sign in with' })

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
    />
  </div>
</template>
