<script setup lang="ts">
// The account menu: Account, Server Admin for admins, Sign out (public mode, signed in); in
// local mode (no user) a "Local" label with Settings. `collapsed` shows the avatar only.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { MeUser } from '~/composables/useMe'

const props = withDefaults(defineProps<{
  user: MeUser | null
  collapsed?: boolean
  block?: boolean
}>(), { collapsed: false, block: false })

const items = computed<DropdownMenuItem[][]>(() => props.user
  ? [
      [{ label: props.user.name, type: 'label', avatar: { src: safeAvatar(props.user.avatar), alt: props.user.name } }],
      [
        { label: 'Account', icon: 'i-lucide-user', to: '/settings/account' },
        ...(props.user.isAdmin ? [{ label: 'Server Admin', icon: 'i-lucide-shield', to: '/settings/admin' }] : [])
      ],
      [{ label: 'Sign out', icon: 'i-lucide-log-out', to: '/logout' }]
    ]
  : [
      [{ label: 'Local', type: 'label' }],
      [{ label: 'Settings', icon: 'i-lucide-settings', to: '/settings/account' }]
    ])

const name = computed(() => props.user?.name ?? 'Local')
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'end' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      :block="block"
      :square="collapsed"
      :aria-label="`Account: ${name}`"
      :class="block ? 'justify-start' : undefined"
    >
      <UAvatar
        v-if="user"
        :src="safeAvatar(user.avatar)"
        :alt="user.name"
        size="xs"
      />
      <UIcon
        v-else
        name="i-lucide-hard-drive"
        class="size-5"
      />
      <span
        v-if="!collapsed"
        class="max-w-40 truncate max-sm:hidden"
      >{{ name }}</span>
    </UButton>
  </UDropdownMenu>
</template>
