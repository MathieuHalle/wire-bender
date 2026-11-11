<script setup lang="ts">
// Boards opened from someone else's link. Local mode has no sharing: back to My boards.
definePageMeta({ layout: 'dashboard', middleware: 'signed-in' })

const { me } = useMe()
watch(me, (m) => {
  if (m?.mode === 'local') void navigateTo('/boards', { replace: true })
}, { immediate: true })
</script>

<template>
  <UDashboardPanel id="boards-shared">
    <template #header>
      <UDashboardNavbar title="Shared with me" />
    </template>

    <template #body>
      <BoardList list="shared" />
    </template>
  </UDashboardPanel>
</template>
