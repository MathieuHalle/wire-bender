// The open board, kept in sync with the board file on disk.
//
// - Edits (`apply`, `undo`, `redo`) autosave after 400 ms. A PUT names its base as the
//   revision and the file hash we last saw on disk; the server refuses (409) when the
//   file is no longer that one, so a hand edit that keeps `revision` is never overwritten.
// - We remember the content last confirmed on disk (`diskSnapshot`, set on load and on
//   every successful PUT to what we sent). Every SSE event (any revision, or
//   `{errors:true}`) and every (re)connect runs one single-flight GET and compares the
//   disk with that snapshot:
//     equal     -> no external change (our own echo, a reformat): record its revision;
//     different -> external change: a conflict if an edit is pending, else reload.
//   A check that would overlap a PUT in flight waits for it to settle, so our own write
//   is already the snapshot by the time its echo is judged.
//   A check whose GET overlapped a whole PUT (started and finished meanwhile) reads again.
// - A save that failed (network) keeps its error shown until a save succeeds, and is
//   retried on the next check (an SSE event or reconnect) that finds the disk unchanged.
// - A board file that doesn't parse: keep the last good board, show the errors.
// - Closing the tab with an edit pending flushes it with a keepalive PUT and asks the
//   browser to warn.
import { computed, ref, shallowRef } from 'vue'
import type { BoardFile } from '~core/schema'

export type BoardStatus = 'saved' | 'saving' | 'conflict' | 'error'
/** Where the shown errors come from: the file on disk, a failed save, or a lost server. */
export type ErrorKind = 'file' | 'save' | 'server'

const DEBOUNCE_MS = 400
const HISTORY_CAP = 100
const NO_SERVER = 'cannot reach the WireBender server'

type GetOk = { path: string, board: BoardFile, hash: string }
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
  const errorKind = ref<ErrorKind | null>(null)
  const path = ref('')
  const current = ref(0)
  const status = ref<BoardStatus>('saved')
  const undoStack = shallowRef<BoardFile[]>([])
  const redoStack = shallowRef<BoardFile[]>([])

  // What we know is on disk.
  let diskSnapshot: string | null = null
  let diskHash = ''
  /** The board object last written or loaded; another object means unsaved edits. */
  let savedBoard: BoardFile | null = null

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let saveAgain = false

  let checking: Promise<void> | null = null
  let checkAgain = false
  /** A check that came while a PUT was in flight; run once it settles. */
  let checkAfterPut = false

  /** Bumped when a PUT starts: a check whose GET overlapped one judges a stale read. */
  let writeGen = 0

  /** An edit not yet confirmed on disk: debounce running, PUT in flight, or unsaved. */
  const pending = () => timer !== null || inFlight !== null || savedBoard !== board.value

  function showErrors(kind: ErrorKind, list: string[]) {
    errors.value = list
    errorKind.value = kind
  }

  function clearErrors() {
    errors.value = []
    errorKind.value = null
  }

  /** An edit is waiting with nothing on its way to disk (a save failed): try again. */
  function retryIfStuck() {
    if (pending() && !timer && !inFlight && status.value !== 'conflict') schedule()
  }

  async function get(): Promise<{ ok: true, body: GetOk } | { ok: false, body: GetBad | null }> {
    try {
      return { ok: true, body: await $fetch<GetOk>('/api/board') }
    } catch (e) {
      const { status: s, data } = errorBody(e)
      if (s === 422 && data) return { ok: false, body: data as unknown as GetBad }
      return { ok: false, body: null }
    }
  }

  function take(r: GetOk) {
    if (timer) clearTimeout(timer)
    timer = null
    board.value = r.board
    savedBoard = r.board
    diskSnapshot = canonical(r.board)
    diskHash = r.hash
    current.value = r.board.revision
    path.value = r.path
    clearErrors()
    undoStack.value = []
    redoStack.value = []
    status.value = 'saved'
  }

  async function checkOnce() {
    if (inFlight) {
      checkAfterPut = true
      return
    }
    const gen = writeGen
    const r = await get()
    if (inFlight) {
      // A PUT started while we were reading; judge the disk once it has settled.
      checkAfterPut = true
      return
    }
    if (gen !== writeGen) {
      // A PUT started and finished while we were reading: the read is stale, read again.
      checkAgain = true
      return
    }
    if (!r.ok) {
      if (r.body) path.value = r.body.path
      // A failed save stays the error shown until a save succeeds.
      if (errorKind.value !== 'save' || r.body) showErrors(r.body ? 'file' : 'server', r.body?.errors ?? [NO_SERVER])
      if (status.value !== 'conflict') status.value = 'error'
      retryIfStuck()
      return
    }
    path.value = r.body.path
    if (!board.value || diskSnapshot === null) return take(r.body)
    if (canonical(r.body.board) === diskSnapshot) {
      // No external change (our own echo, or only revision/formatting differ).
      current.value = r.body.board.revision
      diskHash = r.body.hash
      if (errorKind.value !== 'save' || !pending()) clearErrors()
      if (status.value === 'error') status.value = pending() ? 'saving' : 'saved'
      retryIfStuck()
      return
    }
    if (pending() || status.value === 'conflict') {
      clearErrors()
      status.value = 'conflict'
      return
    }
    take(r.body)
  }

  /** Single-flight: calls during a check coalesce into one re-run after it. */
  function checkDisk(): Promise<void> {
    if (checking) {
      checkAgain = true
      return checking
    }
    checking = (async () => {
      try {
        do {
          checkAgain = false
          await checkOnce()
        } while (checkAgain)
      } finally {
        checking = null
      }
    })()
    return checking
  }

  /** keepalive uses plain fetch, started synchronously, so it survives the tab closing. */
  function send(body: Record<string, unknown>, keepalive: boolean): Promise<{ revision: number, hash: string }> {
    if (!keepalive) return $fetch<{ revision: number, hash: string }>('/api/board', { method: 'PUT', body })
    return fetch('/api/board', {
      method: 'PUT',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(async (r) => {
      const data = await r.json().catch(() => null)
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { response: { status: r.status }, data })
      return data
    })
  }

  async function put(force = false, keepalive = false) {
    timer = null
    if (!board.value || (status.value === 'conflict' && !force)) return
    if (inFlight) {
      saveAgain = true
      return
    }
    const sent = board.value
    status.value = 'saving'
    writeGen++
    inFlight = (async () => {
      try {
        const res = await send({ baseRevision: current.value, baseHash: diskHash, board: sent }, keepalive)
        current.value = res.revision
        diskHash = res.hash
        diskSnapshot = canonical(sent)
        savedBoard = sent
        clearErrors()
      } catch (e) {
        const { status: s, data } = errorBody(e)
        if (s === 409) {
          status.value = 'conflict'
        } else {
          status.value = 'error'
          showErrors('save', (data?.errors as string[] | undefined) ?? [`save failed: ${(e as Error).message}`])
        }
      }
    })()
    await inFlight
    inFlight = null
    const after = status.value as BoardStatus // the request may have changed it
    if (after === 'saving') status.value = pending() ? 'saving' : 'saved'
    if (saveAgain && after !== 'conflict') {
      saveAgain = false
      await put()
    }
    saveAgain = false
    if (checkAfterPut && !inFlight) {
      checkAfterPut = false
      await checkDisk()
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = null
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
    if (r.ok) return take(r.body)
    showErrors(r.body ? 'file' : 'server', r.body?.errors ?? [NO_SERVER])
    status.value = 'error'
  }

  /** Write our board over the disk version (the owner chose this in the conflict banner). */
  async function keepMine() {
    if (timer) clearTimeout(timer)
    timer = null
    if (inFlight) await inFlight
    const r = await get()
    if (!r.ok) {
      showErrors(r.body ? 'file' : 'server', r.body?.errors ?? [NO_SERVER])
      status.value = 'error'
      return
    }
    current.value = r.body.board.revision
    diskHash = r.body.hash
    diskSnapshot = canonical(r.body.board)
    status.value = 'saving'
    await put(true)
  }

  /** Tab closing with an edit pending: send it now (keepalive) and ask the browser to warn. */
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!board.value || !pending()) return
    if (timer && !inFlight) {
      // Goes through the normal save path, so if the owner stays, its echo is ours.
      clearTimeout(timer)
      void put(false, true)
    }
    e.preventDefault()
    e.returnValue = ''
  }

  let source: EventSource | null = null
  function start() {
    if (source) return
    void checkDisk()
    source = new EventSource('/api/board/events')
    // Fires on the first connect and on every automatic reconnect.
    source.onopen = () => void checkDisk()
    // Every event, whatever its revision: the content comparison decides.
    source.addEventListener('revision', () => void checkDisk())
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', onBeforeUnload)
  }

  return {
    board,
    errors,
    errorKind,
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
