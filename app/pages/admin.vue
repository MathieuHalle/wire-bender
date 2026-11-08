<script setup lang="ts">
// The admin page (spec §3): every account, with its premium and admin flags and
// Suspend/Unsuspend. The last admin can't drop their own flag (the server says so, R13).
// Nothing else: the admin sees how many boards an account has, never the boards. For anyone
// but the admin the API answers 404, and so does this page.
import type { Provider } from '~/composables/useMe'

useHead({ title: 'Admin · WireBender' })

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

const { me, load } = useMe()
onMounted(() => void load())

// Loaded on the client only: who is asking is per browser.
const { data: accounts, error, status } = useFetch<Account[]>('/api/admin/users', { server: false })
const notFound = computed(() => error.value?.statusCode === 404)

const busy = ref<string | null>(null)
const toast = useToast()

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' })

async function change(a: Account, body: { premium?: boolean, suspended?: boolean, admin?: boolean }) {
  busy.value = a.id
  try {
    const updated = await $fetch<Account>(`/api/admin/users/${encodeURIComponent(a.id)}`, { method: 'PATCH', body })
    if (accounts.value) accounts.value = accounts.value.map(x => x.id === updated.id ? updated : x)
  } catch (e) {
    const data = (e as { data?: { error?: unknown, errors?: unknown } }).data
    const message = typeof data?.error === 'string' ? data.error : Array.isArray(data?.errors) ? data.errors.map(String).join(' ') : (e as Error).message
    toast.add({ title: 'Not changed', description: message, color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-5 p-6">
    <header class="flex items-center gap-3">
      <NuxtLink
        to="/"
        aria-label="Boards"
      >
        <img
          src="/icon.svg"
          alt=""
          width="28"
          height="28"
        >
      </NuxtLink>
      <h1 class="text-xl font-semibold">
        {{ notFound ? 'Page not found' : 'Accounts' }}
      </h1>
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
