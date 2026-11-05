// The open board, kept in sync with the board file on disk.
//
// - Edits (`apply`, `undo`, `redo`) autosave after 400 ms with `baseRevision` = the
//   revision we last saw on disk. After our PUT returns r, current = r.
// - Disk changes arrive as SSE `revision` events. Older revisions are ignored. For
//   anything else we GET the file and compare it with what we hold: identical (our own
//   echo) does nothing; different with nothing pending reloads; different while an edit
//   is pending (debounce not flushed, PUT in flight, or unsaved) is a conflict and
//   nothing is overwritten. Same-revision events are checked too, so a hand edit that
//   didn't bump `revision` still shows up.
// - A board file that doesn't parse: keep the last good board, show the errors.
// - On SSE connect and every reconnect, refetch.
import { computed, ref, shallowRef } from 'vue'
import type { BoardFile } from '~core/schema'

export type BoardStatus = 'saved' | 'saving' | 'conflict' | 'error'

const DEBOUNCE_MS = 400
const HISTORY_CAP = 100

type GetOk = { path: string, board: BoardFile }
type GetBad = { path: string, errors: string[] }

/** Board content without the revision, keys sorted, for "is this the same board?". */
function canonical(b: BoardFile): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.fromEntries(Object.keys(o).sort().map(k => [k, sort(o[k])]))
    }
    return v
  }
  const { revision: _r, ...rest } = b
  return JSON.stringify(sort(rest))
}

function errorBody(e: unknown): { status?: number, data?: Record<string, unknown> } {
  const x = e as { response?: { status?: number }, statusCode?: number, data?: Record<string, unknown> }
  return { status: x?.response?.status ?? x?.statusCode, data: x?.data }
}

/** Exported for tests; the app uses `useBoard()`. */
export function createBoardStore() {
  const board = shallowRef<BoardFile | null>(null)
  const errors = ref<string[]>([])
  const path = ref('')
  const current = ref(0)
  const status = ref<BoardStatus>('saved')
  const undoStack = shallowRef<BoardFile[]>([])
  const redoStack = shallowRef<BoardFile[]>([])

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let saveAgain = false
  /** The board as last confirmed equal to disk; null when we have unsaved changes. */
  let savedSnapshot: BoardFile | null = null
  /** An SSE event that came while a PUT was in flight; handled once it settles. */
  let deferredEvent = false

  const pending = () => timer !== null || inFlight !== null || savedSnapshot !== board.value

  async function get(): Promise<{ ok: true, body: GetOk } | { ok: false, body: GetBad | null }> {
    try {
      return { ok: true, body: await $fetch<GetOk>('/api/board') }
    } catch (e) {
      const { status: s, data } = errorBody(e)
      if (s === 422 && data) return { ok: false, body: data as unknown as GetBad }
      return { ok: false, body: null }
    }
  }

  function take(b: BoardFile, p: string) {
    if (timer) clearTimeout(timer)
    timer = null
    board.value = b
    savedSnapshot = b
    current.value = b.revision
    path.value = p
    errors.value = []
    undoStack.value = []
    redoStack.value = []
    status.value = 'saved'
  }

  /** Compare disk with what we hold and act (reload, no-op, conflict, errors). */
  async function checkDisk() {
    if (inFlight) {
      deferredEvent = true
      return
    }
    const r = await get()
    if (!r.ok) {
      if (r.body) {
        path.value = r.body.path
        errors.value = r.body.errors
      } else {
        errors.value = ['cannot reach the WireBender server']
      }
      if (status.value !== 'conflict') status.value = 'error'
      return
    }
    const disk = r.body.board
    path.value = r.body.path
    if (!board.value) return take(disk, r.body.path)
    if (disk.revision < current.value) return // stale read
    if (canonical(disk) === canonical(board.value)) {
      // Same content: our own echo, or the file was only reformatted.
      current.value = disk.revision
      errors.value = []
      if (timer === null && inFlight === null) savedSnapshot = board.value
      if (status.value === 'error' || status.value === 'conflict') status.value = pending() ? 'saving' : 'saved'
      return
    }
    if (pending() || status.value === 'conflict') {
      errors.value = []
      status.value = 'conflict'
      return
    }
    take(disk, r.body.path)
  }

  function onRevision(rev: number | null) {
    if (rev !== null && rev < current.value) return
    void checkDisk()
  }

  async function put(force = false) {
    timer = null
    if (!board.value || (status.value === 'conflict' && !force)) return
    if (inFlight) {
      saveAgain = true
      return
    }
    const snapshot = board.value
    status.value = 'saving'
    inFlight = (async () => {
      try {
        const res = await $fetch<{ revision: number }>('/api/board', {
          method: 'PUT',
          body: { baseRevision: current.value, board: snapshot }
        })
        current.value = res.revision
        if (board.value === snapshot) savedSnapshot = snapshot
        errors.value = []
        status.value = pending() && board.value !== snapshot ? 'saving' : 'saved'
      } catch (e) {
        const { status: s, data } = errorBody(e)
        if (s === 409) {
          status.value = 'conflict'
        } else {
          status.value = 'error'
          errors.value = (data?.errors as string[] | undefined) ?? [`save failed: ${(e as Error).message}`]
        }
      }
    })()
    await inFlight
    inFlight = null
    // Re-read: the request above may have changed it.
    const after = status.value as BoardStatus
    if (saveAgain && after !== 'conflict') {
      saveAgain = false
      await put()
    } else {
      saveAgain = false
    }
    if (status.value === 'saving' && !pending()) status.value = 'saved'
    if (deferredEvent && !inFlight) {
      deferredEvent = false
      await checkDisk()
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    if (status.value === 'conflict') return // nothing is written until the owner picks
    status.value = 'saving'
    timer = setTimeout(() => void put(), DEBOUNCE_MS)
  }

  function setBoard(next: BoardFile) {
    board.value = next
    schedule()
  }

  function apply(next: BoardFile) {
    if (!board.value || next === board.value) return
    undoStack.value = [...undoStack.value, board.value].slice(-HISTORY_CAP)
    redoStack.value = []
    setBoard(next)
  }

  function undo() {
    const prev = undoStack.value.at(-1)
    if (!prev || !board.value) return
    undoStack.value = undoStack.value.slice(0, -1)
    redoStack.value = [...redoStack.value, board.value]
    setBoard(prev)
  }

  function redo() {
    const next = redoStack.value.at(-1)
    if (!next || !board.value) return
    redoStack.value = redoStack.value.slice(0, -1)
    undoStack.value = [...undoStack.value, board.value].slice(-HISTORY_CAP)
    setBoard(next)
  }

  /** Drop our changes and take the file as it is on disk. */
  async function reloadFromDisk() {
    if (timer) clearTimeout(timer)
    timer = null
    if (inFlight) await inFlight
    const r = await get()
    if (r.ok) return take(r.body.board, r.body.path)
    errors.value = r.body?.errors ?? ['cannot reach the WireBender server']
    status.value = 'error'
  }

  /** Write our board over the disk version (the owner chose this in the conflict banner). */
  async function keepMine() {
    if (timer) clearTimeout(timer)
    timer = null
    if (inFlight) await inFlight
    const r = await get()
    if (!r.ok) {
      errors.value = r.body?.errors ?? ['cannot reach the WireBender server']
      status.value = 'error'
      return
    }
    current.value = r.body.board.revision
    status.value = 'saving'
    await put(true)
  }

  let source: EventSource | null = null
  function start() {
    if (source) return
    void checkDisk()
    source = new EventSource('/api/board/events')
    // Fires on the first connect and on every automatic reconnect.
    source.onopen = () => void checkDisk()
    source.addEventListener('revision', (ev) => {
      let data: { revision?: number, errors?: boolean }
      try {
        data = JSON.parse((ev as MessageEvent).data)
      } catch {
        return
      }
      onRevision(data.errors ? null : (data.revision ?? null))
    })
  }

  return {
    board,
    errors,
    path,
    revision: computed(() => current.value),
    status,
    canUndo: computed(() => undoStack.value.length > 0),
    canRedo: computed(() => redoStack.value.length > 0),
    apply,
    undo,
    redo,
    reloadFromDisk,
    keepMine,
    start
  }
}

let store: ReturnType<typeof createBoardStore> | null = null

/** One shared board store per browser tab; the file sync starts on the client only. */
export function useBoard() {
  if (import.meta.server) return createBoardStore()
  if (!store) store = createBoardStore()
  store.start()
  return store
}
