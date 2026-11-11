<script setup lang="ts">
// Trashed boards: Restore, or Delete for good after typing the name.
definePageMeta({ layout: 'dashboard', middleware: 'signed-in' })
</script>

<template>
  <UDashboardPanel id="boards-trash">
    <template #header>
      <UDashboardNavbar title="Trash" />
    </template>

    <template #body>
      <BoardList list="trash" />
    </template>
  </UDashboardPanel>
</template>
