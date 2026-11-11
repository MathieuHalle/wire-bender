<script setup lang="ts">
// The shell of every dashboard page: a collapsible sidebar (boards, settings, help, account) and search.
import type { NavigationMenuItem } from '@nuxt/ui'
import { BOARD_LIST_LINKS, boardLists, type BoardList } from '~/utils/nav'

const { me, load } = useMe()
await load()

const links = computed<NavigationMenuItem[]>(() => [
  {
    label: 'Boards',
    icon: 'i-lucide-layout-grid',
    to: '/boards',
    defaultOpen: true,
    type: 'trigger',
    children: (me.value ? boardLists(me.value) : ['mine'] as BoardList[]).map(k => BOARD_LIST_LINKS[k])
  },
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' }
])

const help: NavigationMenuItem[] = [{
  label: 'Help & docs',
  icon: 'i-lucide-circle-help',
  to: 'https://github.com/MathieuHalle/wire-bender#readme',
  target: '_blank'
}]
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      collapsible
      resizable
      class="bg-elevated/25"
      :ui="{ footer: 'lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/"
          class="flex items-center gap-2"
        >
          <img
            src="/icon.svg"
            alt=""
            class="size-6 shrink-0"
          >
          <span
            v-if="!collapsed"
            class="font-semibold"
          >WireBender</span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UDashboardSearchButton
          :collapsed="collapsed"
          class="bg-transparent ring-default"
        />
        <UNavigationMenu
          :collapsed="collapsed"
          :items="links"
          orientation="vertical"
          tooltip
          popover
        />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full flex-col gap-1">
          <UNavigationMenu
            :collapsed="collapsed"
            :items="help"
            orientation="vertical"
            tooltip
          />
          <AccountMenu
            v-if="me"
            :user="me.user"
            :collapsed="collapsed"
            block
          />
        </div>
      </template>
    </UDashboardSidebar>

    <DashboardSearch />

    <slot />
  </UDashboardGroup>
</template>
