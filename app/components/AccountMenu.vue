<script setup lang="ts">
// The header's account menu (public mode, signed in): Account, Admin for admins, Sign out.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { MeUser } from '~/composables/useMe'

const props = defineProps<{ user: MeUser }>()
const { signOut } = useMe()

async function out() {
  await signOut()
  await navigateTo('/', { replace: true })
}

const items = computed<DropdownMenuItem[][]>(() => [
  [{ label: props.user.name, type: 'label', avatar: { src: safeAvatar(props.user.avatar), alt: props.user.name } }],
  [
    { label: 'Account', icon: 'i-lucide-user', to: '/account' },
    ...(props.user.isAdmin ? [{ label: 'Admin', icon: 'i-lucide-shield', to: '/admin' }] : [])
  ],
  [{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: () => void out() }]
])
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'end' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      :aria-label="`Account: ${user.name}`"
    >
      <UAvatar
        :src="safeAvatar(user.avatar)"
        :alt="user.name"
        size="xs"
      />
      <span class="max-w-40 truncate max-sm:hidden">{{ user.name }}</span>
    </UButton>
  </UDropdownMenu>
</template>
