<script setup lang="ts">
// My boards. Navbar: Import (a .wirebender.json or .zip) and New board.
definePageMeta({ layout: 'dashboard', middleware: 'signed-in' })

const { me } = useMe()
const creating = ref(false)
const importErrors = ref<{ file: string, errors: string[] } | null>(null)
</script>

<template>
  <UDashboardPanel id="boards">
    <template #header>
      <UDashboardNavbar title="My boards">
        <template
          v-if="me"
          #right
        >
          <BoardImportButton
            @start="importErrors = null"
            @failed="importErrors = $event"
          />
          <UButton
            icon="i-lucide-plus"
            label="New board"
            @click="creating = true"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        v-if="importErrors"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="`${importErrors.file} was not imported`"
        close
        @update:open="importErrors = null"
      >
        <template #description>
          <ul class="max-h-[40dvh] overflow-y-auto font-mono text-xs">
            <li
              v-for="e in importErrors.errors"
              :key="e"
            >
              {{ e }}
            </li>
          </ul>
        </template>
      </UAlert>
      <BoardList list="mine" />
      <NewBoardModal v-model:open="creating" />
    </template>
  </UDashboardPanel>
</template>
