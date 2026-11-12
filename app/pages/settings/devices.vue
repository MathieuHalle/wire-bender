<script setup lang="ts">
// The Devices tab: pair a tablet or phone, and the devices already paired. Local mode only.
useHead({ title: 'Devices · WireBender' })

const { me } = useMe()
watch(me, (m) => {
  if (m && m.mode !== 'local') void navigateTo('/settings/account', { replace: true })
}, { immediate: true })

// A device just used the code shown: it is spent, so show a fresh one for the next device.
const pair = ref<{ newCode: () => Promise<void> } | null>(null)
</script>

<template>
  <div
    v-if="me?.mode === 'local'"
    class="flex max-w-md flex-col gap-8"
  >
    <PairPanel ref="pair" />
    <DevicesPanel @paired="pair?.newCode()" />
  </div>
</template>
