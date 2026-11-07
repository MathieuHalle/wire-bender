<script setup lang="ts">
// "Pair a device": a single-use code (10 minutes) and a QR code of the address to open on
// the device. Opening the dialog asks the server for a new code.
import { renderSVG } from 'uqr'

const open = defineModel<boolean>('open', { default: false })

interface Pairing { code: string, expiresAt: number, url: string }
const pairing = ref<Pairing | null>(null)
const error = ref<string | null>(null)
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

async function newCode() {
  error.value = null
  try {
    pairing.value = await $fetch<Pairing>('/api/pair/start', { method: 'POST' })
    now.value = Date.now()
  } catch (e) {
    pairing.value = null
    error.value = `Could not get a pairing code: ${(e as Error).message}`
  }
}

watch(open, (o) => {
  if (tick) clearInterval(tick)
  tick = null
  if (!o) return
  pairing.value = null
  void newCode()
  tick = setInterval(() => (now.value = Date.now()), 1000)
}, { immediate: true })
onBeforeUnmount(() => tick && clearInterval(tick))

const left = computed(() => (pairing.value ? Math.max(0, pairing.value.expiresAt - now.value) : 0))
const expired = computed(() => pairing.value !== null && left.value === 0)
const countdown = computed(() => {
  const s = Math.ceil(left.value / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
/** The code in two groups of three, easier to read across the room. */
const shown = computed(() => (pairing.value ? `${pairing.value.code.slice(0, 3)} ${pairing.value.code.slice(3)}` : ''))
const qr = computed(() => (pairing.value ? renderSVG(pairing.value.url, { border: 2 }) : ''))
</script>

<template>
  <UModal
    v-model:open="open"
    title="Pair a device"
    description="On the tablet or phone, open the address below (or scan the QR code) and enter the code."
  >
    <template #body>
      <p
        v-if="error"
        class="text-error"
      >
        {{ error }}
      </p>
      <p
        v-else-if="!pairing"
        class="text-muted"
      >
        Getting a code…
      </p>
      <div
        v-else
        class="flex flex-col items-center gap-3"
      >
        <p
          class="font-mono text-5xl font-semibold tracking-widest"
          :class="expired ? 'text-muted line-through' : ''"
          aria-label="Pairing code"
        >
          {{ shown }}
        </p>
        <p
          class="text-sm"
          :class="expired ? 'text-error' : 'text-muted'"
        >
          {{ expired ? 'This code has expired.' : `Expires in ${countdown}. It works once.` }}
        </p>
        <!-- The SVG comes from uqr, made from the server's own address: no user input. -->
        <!-- eslint-disable vue/no-v-html -->
        <div
          class="size-48 rounded bg-white p-1 [&>svg]:size-full"
          role="img"
          :aria-label="`QR code for ${pairing.url}`"
          v-html="qr"
        />
        <!-- eslint-enable vue/no-v-html -->
        <p class="font-mono text-sm">
          {{ pairing.url }}
        </p>
      </div>
    </template>
    <template #footer>
      <UButton
        variant="outline"
        icon="i-lucide-refresh-cw"
        label="New code"
        @click="newCode"
      />
      <UButton
        label="Done"
        @click="open = false"
      />
    </template>
  </UModal>
</template>
