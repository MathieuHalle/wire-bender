<script setup lang="ts">
// The Server Admin tab (spec §3): every account, with its premium and admin flags and
// Suspend/Unsuspend. The last admin can't drop their own flag (the server says so, R13).
// Nothing else: the admin sees how many boards an account has, never the boards. For anyone
// but the admin the API answers 404, and so does this tab. Local mode has no accounts: it goes to Account.
import type { Provider } from '~/composables/useMe'
import { saveZip } from '~/utils/download'

useHead({ title: 'Server Admin · WireBender' })

interface Account {
  id: string
  name: string
  avatar: string | null
  providers: Provider[]
  boards: number
  createdAt: number
  isPremium: boolean
  isAdmin: boolean
  suspendedAt: number | null
  deletedAt: number | null
}

const LABEL: Record<Provider, string> = { github: 'GitHub', google: 'Google' }

const { me } = useMe()

// Loaded on the client only (who is asking is per browser), and only in public mode: local
// mode leaves this tab before asking.
const { data: accounts, error, status, execute } = useFetch<Account[]>('/api/admin/users', { server: false, immediate: false })

watch(me, (m) => {
  if (m?.mode === 'local') void navigateTo('/settings/account', { replace: true })
  else if (m && status.value === 'idle') void execute()
}, { immediate: true })
const notFound = computed(() => error.value?.statusCode === 404)

const busy = ref<string | null>(null)
const toast = useToast()

const exporting = ref(false)
async function downloadEvery() {
  exporting.value = true
  const refused = await saveZip('/api/admin/export', 'wirebender-server.zip')
  exporting.value = false
  toast.add(refused
    ? { title: refused, color: 'error', icon: 'i-lucide-ban' }
    : { title: 'Download started', color: 'success', icon: 'i-lucide-check' })
}

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' })

async function change(a: Account, body: { premium?: boolean, suspended?: boolean, admin?: boolean }) {
  busy.value = a.id
  try {
    const updated = await $fetch<Account>(`/api/admin/users/${encodeURIComponent(a.id)}`, { method: 'PATCH', body })
    if (accounts.value) accounts.value = accounts.value.map(x => x.id === updated.id ? updated : x)
  } catch (e) {
    toast.add({ title: 'Not changed', description: errorsOf(e).join(' '), color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div
    v-if="me && me.mode !== 'local'"
    class="flex max-w-5xl flex-col gap-5"
  >
    <header class="flex items-center gap-3">
      <h2 class="text-base font-semibold">
        {{ notFound ? 'Page not found' : 'Accounts' }}
      </h2>
      <UButton
        v-if="accounts"
        class="ml-auto"
        icon="i-lucide-download"
        label="Download every board"
        variant="outline"
        :loading="exporting"
        @click="downloadEvery"
      />
    </header>

    <template v-if="notFound">
      <p class="text-sm text-muted">
        There is nothing at this address.
      </p>
      <UButton
        to="/"
        label="Back to boards"
        variant="soft"
        class="self-start"
      />
    </template>

    <p
      v-else-if="error"
      class="text-sm text-error"
      role="alert"
    >
      The accounts could not be loaded. Reload the page to try again.
    </p>

    <p
      v-else-if="status === 'pending' || !accounts"
      class="text-sm text-muted"
    >
      Loading…
    </p>

    <p
      v-else-if="accounts.length === 0"
      class="text-sm text-muted"
    >
      No accounts yet.
    </p>

    <div
      v-else
      class="overflow-x-auto rounded-md border border-default"
    >
      <table class="w-full text-sm">
        <thead class="bg-elevated text-left text-muted">
          <tr>
            <th class="px-3 py-2 font-medium">
              Account
            </th>
            <th class="px-3 py-2 font-medium">
              Boards
            </th>
            <th class="px-3 py-2 font-medium">
              Since
            </th>
            <th class="px-3 py-2 font-medium">
              Premium
            </th>
            <th class="px-3 py-2 font-medium">
              Admin
            </th>
            <th class="px-3 py-2 font-medium">
              Status
            </th>
            <th class="px-3 py-2">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in accounts"
            :key="a.id"
            class="border-t border-default"
          >
            <td class="px-3 py-2">
              <div class="flex items-center gap-2">
                <UAvatar
                  :src="safeAvatar(a.avatar)"
                  :alt="a.name"
                  size="sm"
                />
                <div class="min-w-0">
                  <p class="truncate font-medium">
                    {{ a.name }}
                    <span
                      v-if="a.id === me?.user?.id"
                      class="text-muted"
                    >(you)</span>
                  </p>
                  <p class="text-xs text-muted">
                    {{ a.providers.map(p => LABEL[p]).join(', ') || 'no sign-in' }}
                  </p>
                </div>
              </div>
            </td>
            <td class="px-3 py-2 tabular-nums">
              {{ a.boards }}
            </td>
            <td class="px-3 py-2 whitespace-nowrap">
              {{ day(a.createdAt) }}
            </td>
            <td class="px-3 py-2">
              <USwitch
                :model-value="a.isPremium"
                :disabled="busy === a.id"
                :aria-label="`Premium for ${a.name}`"
                @update:model-value="(v: boolean) => change(a, { premium: v })"
              />
            </td>
            <td class="px-3 py-2">
              <USwitch
                :model-value="a.isAdmin"
                :disabled="busy === a.id"
                :aria-label="`Admin for ${a.name}`"
                @update:model-value="(v: boolean) => change(a, { admin: v })"
              />
            </td>
            <td class="px-3 py-2">
              <div class="flex flex-wrap gap-1">
                <UBadge
                  v-if="a.suspendedAt"
                  :label="`Suspended ${day(a.suspendedAt)}`"
                  color="error"
                  variant="subtle"
                />
                <UBadge
                  v-if="a.deletedAt"
                  :label="`Deleted ${day(a.deletedAt)}`"
                  color="neutral"
                  variant="subtle"
                />
                <span
                  v-if="!a.suspendedAt && !a.deletedAt"
                  class="text-muted"
                >Active</span>
              </div>
            </td>
            <td class="px-3 py-2 text-right">
              <UButton
                v-if="a.id !== me?.user?.id"
                :label="a.suspendedAt ? 'Unsuspend' : 'Suspend'"
                :color="a.suspendedAt ? 'neutral' : 'error'"
                variant="outline"
                size="sm"
                :loading="busy === a.id"
                @click="change(a, { suspended: !a.suspendedAt })"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
