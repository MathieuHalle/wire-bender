<script setup lang="ts">
// "Paired devices": each device's name and when it was last seen, with Unpair. Checked
// again every few seconds while open, so a tablet that just paired shows up ('paired').
interface Device { id: string, name: string, createdAt: number, lastSeen: number }

const POLL_MS = 4000
const emit = defineEmits<{ paired: [name: string] }>()
const devices = ref<Device[] | null>(null)
const error = ref<string | null>(null)
const toast = useToast()

async function load() {
  try {
    const next = await $fetch<Device[]>('/api/devices')
    const known = devices.value && new Set(devices.value.map(d => d.id))
    const added = known ? next.filter(d => !known.has(d.id)) : []
    devices.value = next
    error.value = null
    for (const d of added) {
      toast.add({ title: `${d.name} is paired`, color: 'success', icon: 'i-lucide-check' })
      emit('paired', d.name)
    }
  } catch (e) {
    error.value = `Could not list the devices: ${(e as Error).message}`
  }
}

let poll: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  poll = setInterval(() => {
    if (document.visibilityState === 'visible') void load()
  }, POLL_MS)
})
onBeforeUnmount(() => poll && clearInterval(poll))

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

async function unpair(d: Device) {
  try {
    await $fetch(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' })
    toast.add({ title: `${d.name} is no longer paired`, color: 'success', icon: 'i-lucide-check' })
  } catch (e) {
    toast.add({ title: `Could not unpair ${d.name}: ${(e as Error).message}`, color: 'error', icon: 'i-lucide-ban' })
  }
  await load()
}
</script>

<template>
  <section class="space-y-3">
    <h2 class="text-sm font-medium">
      Paired devices
    </h2>
    <p
      v-if="error"
      class="text-error"
    >
      {{ error }}
    </p>
    <p
      v-else-if="!devices"
      class="text-muted"
    >
      Loading…
    </p>
    <p
      v-else-if="!devices.length"
      class="text-muted"
    >
      No paired devices. Use the pairing code above to add one.
    </p>
    <ul
      v-else
      class="divide-y divide-default"
    >
      <li
        v-for="d in devices"
        :key="d.id"
        class="flex items-center gap-3 py-2"
      >
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium">
            {{ d.name }}
          </p>
          <p class="text-xs text-muted">
            Last seen {{ when(d.lastSeen) }}
          </p>
        </div>
        <UButton
          size="xs"
          color="error"
          variant="outline"
          label="Unpair"
          @click="unpair(d)"
        />
      </li>
    </ul>
  </section>
</template>
