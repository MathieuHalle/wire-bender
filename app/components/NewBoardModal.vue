<script setup lang="ts">
// The "New board" dialog: name, a preset or Custom (size and copper sides), then the new board's page opens.
import { newBoardBody, PRESET_ITEMS, SHAPE_ITEMS, shownSize, type NewBoardDraft, type ShapeChoice } from '~/utils/newBoard'
import type { BoardSides } from '~core/boardPresets'

const open = defineModel<boolean>('open', { default: false })

const fresh = (): NewBoardDraft => ({ name: '', preset: 'custom', cols: 30, rows: 20, type: 'one-sided', shape: 'rect', cornerHoles: 2 })
const draft = ref<NewBoardDraft>(fresh())
/** A preset's size shows read-only; Custom shows (and edits) the draft's own. */
const size = computed(() => shownSize(draft.value))
const createErrors = ref<string[]>([])
const SIDES = [
  { label: 'One-sided', value: 'one-sided' },
  { label: 'Two-sided', value: 'two-sided' }
]
// A fresh form each time it opens.
watch(open, (o) => {
  if (!o) return
  draft.value = fresh()
  createErrors.value = []
})
async function create() {
  try {
    const { id } = await $fetch<{ id: string }>('/api/boards', { method: 'POST', body: newBoardBody(draft.value) })
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
        <UFormField label="Board">
          <USelect
            v-model="draft.preset"
            :items="PRESET_ITEMS"
            class="w-full"
          />
        </UFormField>
        <div class="flex gap-3">
          <UFormField label="Columns">
            <UInputNumber
              :model-value="size.cols"
              :disabled="size.fixed"
              :min="1"
              @update:model-value="(v: number | null) => (draft.cols = v)"
            />
          </UFormField>
          <UFormField label="Rows">
            <UInputNumber
              :model-value="size.rows"
              :disabled="size.fixed"
              :min="1"
              @update:model-value="(v: number | null) => (draft.rows = v)"
            />
          </UFormField>
        </div>
        <URadioGroup
          :model-value="size.type"
          :disabled="size.fixed"
          legend="Copper"
          orientation="horizontal"
          :items="SIDES"
          @update:model-value="(v: string) => (draft.type = v as BoardSides)"
        />
        <div class="flex gap-3">
          <UFormField
            label="Shape"
            class="flex-1"
          >
            <USelect
              :model-value="size.shape"
              :items="SHAPE_ITEMS"
              :disabled="size.fixed"
              class="w-full"
              @update:model-value="(v: ShapeChoice) => (draft.shape = v)"
            />
          </UFormField>
          <UFormField
            v-if="size.shape === 'chamfer' || size.shape === 'notch'"
            label="Corner size (holes)"
          >
            <UInputNumber
              :model-value="draft.cornerHoles"
              :disabled="size.fixed"
              :min="1"
              @update:model-value="(v: number | null) => (draft.cornerHoles = v)"
            />
          </UFormField>
        </div>
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
