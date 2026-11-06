<script setup lang="ts">
// What the 3D view shows when it cannot draw the board (WebGL off, or the view failed),
// with a way back to the 2D views.
defineProps<{ title: string, description?: string }>()
const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <div class="mx-auto max-w-xl p-4">
    <UAlert
      color="warning"
      variant="subtle"
      icon="i-lucide-box"
      :title="title"
      :description="description"
    >
      <template #actions>
        <UButton
          size="xs"
          color="warning"
          label="Both sides"
          @click="emit('back')"
        />
      </template>
    </UAlert>
  </div>
</template>
