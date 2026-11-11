<script setup lang="ts">
// The "New board" dialog: name, size and copper sides, then the new board's page opens.
const open = defineModel<boolean>('open', { default: false })

const draft = ref({ name: '', cols: 30, rows: 20, type: 'one-sided' as 'one-sided' | 'two-sided' })
const createErrors = ref<string[]>([])
const SIDES = [
  { label: 'One-sided', value: 'one-sided' },
  { label: 'Two-sided', value: 'two-sided' }
]
// A fresh form each time it opens.
watch(open, (o) => {
  if (!o) return
  draft.value = { name: '', cols: 30, rows: 20, type: 'one-sided' }
  createErrors.value = []
})
async function create() {
  try {
    const { id } = await $fetch<{ id: string }>('/api/boards', { method: 'POST', body: draft.value })
    open.value = false
    await navigateTo(`/b/${id}`)
  } catch (e) {
    createErrors.value = errorsOf(e)
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="New board"
  >
    <template #body>
      <form
        id="new-board"
        class="space-y-3"
        @submit.prevent="create"
      >
        <UFormField
          label="Name"
          required
        >
          <UInput
            v-model="draft.name"
            class="w-full"
            autofocus
          />
        </UFormField>
        <div class="flex gap-3">
          <UFormField label="Columns">
            <UInputNumber
              v-model="draft.cols"
              :min="1"
            />
          </UFormField>
          <UFormField label="Rows">
            <UInputNumber
              v-model="draft.rows"
              :min="1"
            />
          </UFormField>
        </div>
        <URadioGroup
          v-model="draft.type"
          legend="Copper"
          orientation="horizontal"
          :items="SIDES"
        />
        <ul
          v-if="createErrors.length"
          class="font-mono text-xs text-error"
        >
          <li
            v-for="e in createErrors"
            :key="e"
          >
            {{ e }}
          </li>
        </ul>
      </form>
    </template>
    <template #footer>
      <UButton
        variant="ghost"
        label="Cancel"
        @click="open = false"
      />
      <UButton
        type="submit"
        form="new-board"
        label="Create"
      />
    </template>
  </UModal>
</template>
