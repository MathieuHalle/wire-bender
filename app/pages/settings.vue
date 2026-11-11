<script setup lang="ts">
// Settings: a tab per area (Account, Devices, Connections, Server Admin), each its own page under /settings.
import type { NavigationMenuItem } from '@nuxt/ui'
import { settingsTabs, type SettingsTab } from '~/utils/nav'

definePageMeta({ layout: 'dashboard', middleware: 'signed-in' })
useHead({ title: 'Settings · WireBender' })

const LABELS: Record<SettingsTab, string> = { account: 'Account', devices: 'Devices', connections: 'Connections', admin: 'Server Admin' }

const { me, failed } = useMe()
const links = computed<NavigationMenuItem[]>(() => me.value
  ? settingsTabs(me.value).map(t => ({ label: LABELS[t], to: `/settings/${t}` }))
  : [])
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings" />
      <UDashboardToolbar>
        <UNavigationMenu
          :items="links"
          highlight
          class="-mx-1 flex-1"
        />
      </UDashboardToolbar>
    </template>

    <template #body>
      <p
        v-if="!me && failed"
        class="text-error"
      >
        Cannot reach the WireBender server.
      </p>
      <p
        v-else-if="!me"
        class="text-muted"
      >
        Loading…
      </p>
      <NuxtPage v-else />
    </template>
  </UDashboardPanel>
</template>
