// One board list (My boards, Shared with me, Trash) of the dashboard pages. Loaded on the
// client only: the lists belong to whoever is signed in in this browser, and times are local.
import { needsLogin, type BoardList } from '~/utils/nav'

export type Visibility = 'view' | 'edit' | 'private'
export interface BoardRow { id: string, name: string, head: number, updatedAt: number, author: string, visibility: Visibility, hasPassword: boolean, trashedAt: number | null }
export interface SharedRow { key: string, name: string, owner: string, role: 'view' | 'edit', lastOpened: number }

/** The errors of a failed request: the API's 422 list, or its message. */
export function errorsOf(e: unknown): string[] {
  const data = (e as { data?: { errors?: unknown, error?: unknown } }).data
  if (Array.isArray(data?.errors)) return data.errors.map(String)
  if (typeof data?.error === 'string') return [data.error]
  return [(e as Error).message]
}

export function useBoardList(list: BoardList) {
  const { me, load: loadMe } = useMe()
  const rows = ref<BoardRow[]>([])
  const sharedRows = ref<SharedRow[]>([])
  const status = ref<'idle' | 'pending' | 'success' | 'error'>('idle')
  /** The lists are for the local user, or a signed-in one. */
  const canList = computed(() => !!me.value && !needsLogin(me.value))

  async function refresh() {
    if (!canList.value) return
    status.value = 'pending'
    try {
      const body = await $fetch<BoardRow[] | SharedRow[]>('/api/boards', { query: { list } })
      if (list === 'shared') sharedRows.value = body as SharedRow[]
      else rows.value = body as BoardRow[]
      status.value = 'success'
    } catch (e) {
      // Signed out meanwhile (another tab): to the sign-in page.
      if ((e as { statusCode?: number }).statusCode === 401 && me.value?.mode === 'public') {
        const now = await loadMe(true)
        // Still signed in (or /api/me unreachable): the list really failed; never "Loading…" for ever.
        if (now && needsLogin(now)) {
          await navigateTo('/login')
          return
        }
      }
      status.value = 'error'
    }
  }

  // `me` is loaded by the layout on mount, so it may arrive after this page does.
  onMounted(() => void refresh())
  watch(canList, can => can && void refresh())

  return { rows, sharedRows, status, refresh }
}
