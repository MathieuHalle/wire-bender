<script setup lang="ts">
// What the 3D view shows when it cannot draw the board (WebGL off, or the view failed),
// with a way back to the 2D views, and a reload when WireBender was updated meanwhile.
defineProps<{ title: string, description?: string, reload?: boolean }>()
const reloadPage = () => window.location.reload()
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
          v-if="reload"
          size="xs"
          color="warning"
          icon="i-lucide-refresh-cw"
          label="Reload"
          @click="reloadPage"
        />
        <UButton
          size="xs"
          color="warning"
          :variant="reload ? 'outline' : 'solid'"
          label="Both sides"
          @click="emit('back')"
        />
      </template>
    </UAlert>
  </div>
</template>
