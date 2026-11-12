// One board list (My boards, Shared with me, Trash) of the dashboard pages. Loaded on the
// client only: the lists belong to whoever is signed in in this browser, and times are local.
import { listFailureTarget, needsLogin, type BoardList } from '~/utils/nav'

export type Visibility = 'view' | 'edit' | 'private'
export interface BoardRow { id: string, name: string, head: number, updatedAt: number, author: string, visibility: Visibility, hasPassword: boolean, trashedAt: number | null }
export interface SharedRow { key: string, name: string, owner: string, role: 'view' | 'edit', lastOpened: number }

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
      const to = await listFailureTarget((e as { statusCode?: number }).statusCode, me.value, () => loadMe(true))
      if (to) {
        await navigateTo(to)
        return
      }
      status.value = 'error'
    }
  }

  // `me` is loaded by the layout on mount, so it may arrive after this page does.
  onMounted(() => void refresh())
  watch(canList, can => can && void refresh())

  return { rows, sharedRows, status, refresh }
}
