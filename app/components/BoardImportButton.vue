<script setup lang="ts">
// The "Import" button: picks a .wirebender.json or .wirebender.zip file, makes a board of it
// and opens it. A refused file is reported to the page with `failed`; `start` clears the last report.
const emit = defineEmits<{ start: [], failed: [error: { file: string, errors: string[] }] }>()

const picker = ref<HTMLInputElement | null>(null)
async function onPick(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  emit('start')
  if (file.name.toLowerCase().endsWith('.zip')) {
    try {
      const { id } = await $fetch<{ id: string }>('/api/boards/import-bundle', { method: 'POST', body: file, headers: { 'content-type': 'application/zip' } })
      await navigateTo(`/b/${id}`)
    } catch (e) {
      emit('failed', { file: file.name, errors: errorsOf(e) })
    }
    return
  }
  let board: unknown
  try {
    board = JSON.parse(await file.text())
  } catch (e) {
    emit('failed', { file: file.name, errors: [`not valid JSON: ${(e as Error).message}`] })
    return
  }
  try {
    const { id } = await $fetch<{ id: string }>('/api/boards', { method: 'POST', body: { board } })
    await navigateTo(`/b/${id}`)
  } catch (e) {
    emit('failed', { file: file.name, errors: errorsOf(e) })
  }
}
</script>

<template>
  <UButton
    icon="i-lucide-upload"
    variant="outline"
    label="Import"
    @click="picker?.click()"
  />
  <input
    ref="picker"
    type="file"
    accept=".json,.zip,application/json,application/zip"
    class="hidden"
    @change="onPick"
  >
</template>
