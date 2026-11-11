<script setup lang="ts">
// The one page an unpaired device can open: enter the code shown on the computer.
definePageMeta({ layout: 'auth' })
useHead({ title: 'Pair this device · WireBender' })

const code = ref('')
const name = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function pair() {
  error.value = null
  busy.value = true
  try {
    await $fetch('/api/pair', { method: 'POST', body: { code: code.value.replace(/\D/g, ''), name: name.value } })
    // A full load: the new cookie now lets every page and the live board in.
    window.location.assign('/')
  } catch (e) {
    const data = (e as { data?: { error?: unknown } }).data
    error.value = typeof data?.error === 'string' ? data.error : `Pairing failed: ${(e as Error).message}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 class="text-lg font-semibold">
      Pair this device
    </h1>
    <p class="text-sm text-muted">
      On the computer running WireBender, open Settings › Devices and choose "Pair a device".
      Enter the code it shows, and a name for this device.
    </p>
    <form
      class="space-y-3"
      @submit.prevent="pair"
    >
      <UFormField
        label="Pairing code"
        required
      >
        <UInput
          v-model="code"
          class="w-full"
          size="xl"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="7"
          placeholder="123 456"
          autofocus
          :ui="{ base: 'font-mono tracking-widest text-center text-2xl' }"
        />
      </UFormField>
      <UFormField
        label="Device name"
        required
        help="Shown to others on a board, e.g. Bench tablet."
      >
        <UInput
          v-model="name"
          class="w-full"
          maxlength="40"
        />
      </UFormField>
      <p
        v-if="error"
        class="text-sm text-error"
      >
        {{ error }}
      </p>
      <UButton
        type="submit"
        block
        size="lg"
        label="Pair"
        :loading="busy"
        :disabled="!code.trim() || !name.trim()"
      />
    </form>
  </div>
</template>
