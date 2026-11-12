<script setup lang="ts">
import { parseHole, tryParseHole, type Hole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import { PREVIEW_TITLE, previewBanner, type RevisionRow } from '~/utils/history'
import { runCheck, type Finding } from '~core/check'
import { tagNets, type Tag } from '~core/scene3d'
import { placePart } from '~core/footprints'
import { buildConnectivity } from '~core/connectivity'
import { jointSide, LOCKED_TITLE, makeGeo, PAUSED_TITLE, pageKey, RETURN_KEY, returnEntry, SIGN_IN_TITLE, sideBox, sideFrames, VIEW_TITLE, type View } from '~/utils/boardView'
import { NO_ACCESS } from '~/composables/useLiveBoard'
import { fallbackAlert } from '~/utils/board3dFallback'
import { defaultPanel, loadPanel, savePanel, type PanelState, type PanelTab } from '~/utils/sidePanel'
import { ALL_LAYERS } from '~/utils/layers'
import {
  boardItems, drawnBoard, editTarget, hiddenCount, isShown, itemLit, itemNets, itemsAtFinding, loadHidden, pruneHidden,
  saveHidden, setShown, type BoardItems, type ViewState
} from '~/utils/hiddenItems'
import { benchUrl, loadFlip, saveFlip } from '~/utils/bottomFlip'
import type { Flip, Mirror } from '~core/sideView'

// `id` is the key the board was opened by: its board id (the owner) or its share link id
// (everyone else, who never sees the board id).
const route = useRoute()
const id = computed(() => String(route.params.id))
const live = useLiveBoard(id)
const { status, readOnly, missing, revision, canUndo, canRedo, peers, undo, redo, role, meta, canEdit, needsPassword, noAccess } = live
const { me } = useMe()
const isPublic = computed(() => me.value?.mode === 'public')
const signedIn = computed(() => !!me.value?.user)
/** Someone else's board, opened by its link. */
const visiting = computed(() => meta.value !== null && role.value !== 'owner')
const viewOnly = computed(() => role.value === 'view')

/**
 * A past revision on show (History tab): its row, and its board once fetched. While it is
 * set the canvas, findings and 3D view show it, and editing is locked.
 */
const previewRow = ref<RevisionRow | null>(null)
const previewBoard = shallowRef<BoardFile | null>(null)
/** Shown on the canvas: the previewed revision once it has arrived, else the live board. */
const board = computed(() => (previewRow.value ? previewBoard.value : null) ?? live.board.value)
const previewing = computed(() => previewRow.value !== null)
const toast = useToast()
watch(previewRow, async (row) => {
  previewBoard.value = null
  if (!row) return
  try {
    const b = await $fetch<BoardFile>(`/api/boards/${encodeURIComponent(id.value)}/revisions/${row.n}`)
    if (previewRow.value?.n === row.n) previewBoard.value = b
  } catch {
    if (previewRow.value?.n === row.n) {
      previewRow.value = null
      toast.add({ title: `Revision #${row.n} could not be loaded.`, color: 'warning', icon: 'i-lucide-ban' })
    }
  }
})
watch(id, () => (previewRow.value = null))

const restoring = ref(false)
async function restore() {
  const row = previewRow.value
  if (!row || restoring.value || !canEdit.value) return
  restoring.value = true
  try {
    await $fetch(`/api/boards/${encodeURIComponent(id.value)}/revisions/${row.n}/restore`, { method: 'POST' })
    previewRow.value = null
  } catch (e) {
    const reason = (e as { data?: { reason?: unknown } }).data?.reason
    toast.add({ title: typeof reason === 'string' ? reason : `Restoring #${row.n} failed: ${(e as Error).message}`, color: 'warning', icon: 'i-lucide-ban' })
  } finally {
    restoring.value = false
  }
}
/**
 * What the canvas was last framed on: both sides, one side (key F flips), or the 3D view
 * (key 3, look only). In 2D a view is a camera move; the user can pan away from it.
 */
const view = ref<View>('both')
/** Why editing is off, if it is: a board that is not live, or the 3D view (look only). */
const lockedTitle = computed(() => (previewing.value
  ? PREVIEW_TITLE
  : viewOnly.value
    ? (meta.value?.signInToEdit ? SIGN_IN_TITLE : VIEW_TITLE)
    : readOnly.value ? PAUSED_TITLE : view.value === '3d' ? LOCKED_TITLE : null))
const { tool, drawing, onHoleClick, onSegmentClick, addJoint, endDrawing } = useTools(live, { locked: () => lockedTitle.value !== null })
/** The 2D view the 3D one was entered from; key 3 goes back to it. */
const last2d = ref<Exclude<View, '3d'>>('both')
// The 3D view has no edit tools: a trail being drawn ends on the way in.
watch(view, (v) => {
  if (v === '3d') endDrawing()
  else last2d.value = v
})

const mirrorBottom = ref(true)
/** How the mirrored bottom is turned over (left-right or top-bottom): the viewer's, stored once mounted. */
const bottomFlip = ref<Flip>('lr')
/** How the bottom is drawn in 2D. */
const bottomMirror = computed<Mirror>(() => (mirrorBottom.value ? bottomFlip.value : 'none'))
/** The canvas zoom, in percent of "fit both sides". */
const zoomPct = ref(100)
const canvas = ref<{ frame(which: 'both' | Side, animate?: boolean): void, zoomStep(dir: 1 | -1): void } | null>(null)

/** 2D or 3D from the top bar: in and out of 3D the canvas keeps its camera, as key 3 does. */
function pickMode(m: '2d' | '3d') {
  if (m === '3d') view.value = '3d'
  else if (view.value === '3d') view.value = last2d.value
}

/** The keys, under the 2D canvas (the full line in its tooltip when it is cut). */
const KEYS = 'H: navigate (drag pans) · I P E J: tools · Ctrl/Cmd+Z: undo · Esc: end trail · scroll: zoom · drag, right-drag or Space+drag: pan · F: frame top/bottom · 0: fit both · + −: zoom · 3: 3D view · [: side panel'

/** What the 2D canvas frames, from the buttons on it. */
const FRAMINGS = [
  { id: 'both', label: 'Both sides', key: '0' },
  { id: 'top', label: 'Top', key: 'F' },
  { id: 'bottom', label: 'Bottom', key: 'F' }
] as const

/** Picks a view; a 2D one frames its sides (once the canvas is there, coming from 3D). */
function pickView(v: View) {
  view.value = v
  if (v !== '3d') nextTick(() => canvas.value?.frame(v))
}

const placed = computed(() => board.value?.parts.map(placePart) ?? [])
const conn = computed(() => (board.value ? buildConnectivity(board.value) : null))

const hover = ref<{ side: Side, hole: Hole } | null>(null)
const highlight = computed(() => {
  const h = hover.value
  if (!h || !conn.value) return null
  const gi = conn.value.groupAtHole(h.hole, h.side)
  return gi === null ? null : conn.value.groups[gi]!
})

/**
 * The mesh hovered in 3D: a conductor or leg lights its group's nets (all of a short, as
 * in 2D), else its own net; a part body only shows its tooltip. `tagNets` is the same rule
 * the 3D highlight uses (core, so the 2D page doesn't import three.js).
 */
const hoverTag = ref<Tag | null>(null)
/** The item hovered in the Layers tab: lit alone, on both views, while it is drawn. */
const hoverItem = ref<string | null>(null)
const highlightNets = computed(() => (hoverItem.value && conn.value
  ? (litItem.value ? itemNets(conn.value, hoverItem.value) : [])
  : tagNets(hoverTag.value)))

/**
 * The side panel: open or collapsed, its tab, and the view layers. Read once mounted (no
 * storage on the server). Until then the panel and the board views are not rendered, on
 * the server and on the client alike (no hydration mismatch), so a stored collapsed or
 * layer-off state never shows its default first.
 */
const panel = ref<PanelState>(defaultPanel())
const loaded = ref(false)
const storage = () => window.localStorage
onMounted(() => {
  // Nothing stored: open from lg up, collapsed below (on a phone it would take the canvas's room).
  const wide = window.matchMedia?.('(min-width: 1024px)').matches ?? true
  panel.value = loadPanel(storage, { ...defaultPanel(), open: wide })
  bottomFlip.value = loadFlip(storage)
  loaded.value = true
  watch(panel, p => savePanel(p, storage), { deep: true })
  watch(bottomFlip, (f) => {
    saveFlip(f, storage)
    // The bottom moved (beside or below): frame what was framed, in its new place.
    const v = view.value
    if (v !== '3d') nextTick(() => canvas.value?.frame(v))
  })
})
/** The layers the views draw: the stored ones once loaded. */
const layers = computed(() => (loaded.value ? panel.value.layers : ALL_LAYERS))

/**
 * This board's hidden items (the Layers tab): this viewer's, in this browser, stored per
 * board key. Never in the board: the views draw `drawnBoard`, the check, history and
 * printouts see the board as it is. Without storage nothing is hidden.
 */
const hidden = ref<string[]>([])
onMounted(() => {
  hidden.value = loadHidden(id.value, storage)
  watch(id, k => (hidden.value = loadHidden(k, storage)))
  watch(hidden, h => saveHidden(id.value, h, storage))
})
// A deleted item's flag is dropped (against the live board, not a previewed revision).
watch([live.board, loaded], ([b, ok]) => {
  if (!b || !ok) return
  const kept = pruneHidden(hidden.value, b)
  if (kept !== hidden.value) hidden.value = kept
})
const hiddenSet = computed(() => new Set(loaded.value ? hidden.value : []))
const NO_ITEMS: BoardItems = { part: [], wire: [], trail: [] }
const items = computed(() => (board.value ? boardItems(board.value) : NO_ITEMS))
const allItems = computed(() => [...items.value.part, ...items.value.wire, ...items.value.trail])
// A row can vanish under the pointer (filter, collapse): the hover ends with the panel.
watch(() => [panel.value.open, panel.value.tab], () => (hoverItem.value = null))
const viewState = computed<ViewState>(() => ({ layers: panel.value.layers, hidden: hidden.value }))
function setView(s: ViewState) {
  panel.value.layers = s.layers
  hidden.value = s.hidden
}
/** Items not drawn, by layer or one by one: the header's "N hidden". */
const hiddenN = computed(() => (loaded.value ? hiddenCount(items.value, viewState.value) : 0))
function openLayers() {
  panel.value.open = true
  panel.value.tab = 'layers'
}
/** What the 3D view draws (the 2D sides filter the same set themselves). */
const drawn = computed(() => (board.value ? drawnBoard(board.value, hiddenSet.value) : null))
/** The hovered item, lit on its own; nothing while it is not drawn. */
const litItem = computed(() => {
  const k = hoverItem.value
  const b = board.value
  if (!k || !b) return null
  const item = allItems.value.find(i => i.key === k)
  return item && isShown(item, viewState.value, hiddenSet.value) ? itemLit(b, k) : null
})
/** Run once here: the Findings tab lists it and its icon counts the errors. */
const check = computed(() => (board.value ? runCheck(board.value) : null))
const badges = computed(() => ({ findings: check.value?.stats.errors ?? 0 }))

/** The finding picked in the panel; its holes are ringed on both sides. */
const picked = ref<Finding | null>(null)
/** The item picked in the Layers tab; its holes are ringed the same way. One pick at a time. */
const pickedItem = ref<string | null>(null)
/** Names that don't parse are skipped: a finding never breaks the drawing. */
const markHoles = computed(() => {
  if (picked.value) return picked.value.holes.flatMap(n => tryParseHole(n) ?? [])
  const k = pickedItem.value
  return k ? allItems.value.find(i => i.key === k)?.holes ?? [] : []
})
/**
 * Picking a finding shows again the hidden items it points at. Only on a new pick: the
 * panel re-picks the same finding after every edit, which must not undo a later hide.
 */
let revealedFor: string | null = null
watch(picked, (f) => {
  const k = f && `${f.rule}|${f.holes.join(',')}|${f.message}`
  if (f) pickedItem.value = null
  if (!f || !board.value || k === revealedFor) {
    revealedFor = k
    return
  }
  revealedFor = k
  const s = viewState.value
  const at = new Set(itemsAtFinding(board.value, f))
  const off = allItems.value.filter(i => at.has(i.key) && !isShown(i, s, hiddenSet.value)).map(i => i.key)
  if (off.length) setView(setShown(off, true, items.value, s))
})
watch(pickedItem, (k) => {
  if (k) picked.value = null
})

function onAddJoint(f: Finding) {
  if (lockedTitle.value) return
  const hole = f.holes[0] ? tryParseHole(f.holes[0]) : null
  if (!hole || !board.value || !conn.value) return
  const side = jointSide(board.value, conn.value, hole) ?? 'bottom'
  addJoint(side, hole)
}

/** The last point of the trail being drawn, on the side it is drawn on. */
const drawFrom = computed(() => {
  const d = drawing.value
  const t = d && board.value?.trails.find(x => x.id === d.trailId)
  return t && t.points.length ? { side: d!.side, hole: parseHole(t.points[t.points.length - 1]!) } : null
})
const hint = computed(() => (drawing.value
  ? `Drawing ${drawing.value.trailId} on ${drawing.value.side}: click the last hole again or press Esc to end`
  : null))

function onHover(side: Side, hole: Hole | null) {
  hover.value = hole ? { side, hole } : null
}

/**
 * Per-side handlers, made once: the canvas re-renders its frames on every pan, and a new
 * handler each time would re-render both sides with it.
 */
const warn = useWarning()
/** True (and a warning) when the tool would change a hidden trail: what isn't drawn isn't edited. */
function editsHidden(side: Side, a: Hole, b?: Hole): boolean {
  const lb = live.board.value
  if (!lb || !hiddenSet.value.size) return false
  const t = editTarget(lb, hiddenSet.value, side, a, b)
  if (t) warn(`Trail ${t} is hidden: show it in Layers to edit it.`)
  return t !== null
}
const sideEvents = Object.fromEntries((['top', 'bottom'] as const).map(s => [s, {
  hover: (h: Hole | null) => onHover(s, h),
  hole: (h: Hole) => (tool.value === 'joint' && editsHidden(s, h)) || onHoleClick(s, h),
  segment: (a: Hole, b: Hole) => (tool.value === 'erase' && editsHidden(s, a, b)) || onSegmentClick(s, a, b)
}])) as Record<Side, { hover(h: Hole | null): void, hole(h: Hole): void, segment(a: Hole, b: Hole): void }>

/** The two sides as frames on the canvas, in mm: the bottom beside the top or below it (the flip). */
const frames = computed(() => {
  const b = board.value
  if (!b) return []
  const size = (s: Side) => {
    const box = sideBox(makeGeo(b, s === 'bottom' ? bottomMirror.value : 'none'), placed.value)
    return { w: box.w, h: box.h }
  }
  const at = sideFrames({ top: size('top'), bottom: size('bottom') }, bottomFlip.value)
  return (['top', 'bottom'] as const).map(s => ({ id: s, title: sideTitle(s), rect: at[s] }))
})

/** "Share": the owner's, in public mode only (local mode offers none). It opens the Sharing tab. */
const canShare = computed(() => isPublic.value && role.value === 'owner')
const hiddenTabs = computed<PanelTab[]>(() => (canShare.value ? [] : ['sharing']))
function openSharing() {
  panel.value.open = true
  panel.value.tab = 'sharing'
}
// The board list's Share button opens /b/<id>#sharing: the Sharing tab, once the panel is
// loaded and the role is known (only the owner can share).
const wantsSharing = ref(route.hash === '#sharing')
watch([canShare, loaded], ([can, ok]) => {
  if (!wantsSharing.value || !can || !ok) return
  wantsSharing.value = false
  openSharing()
  // Done with it: a reload or a copied address should not open Sharing again. Same history
  // entry and state, so the router does not see a navigation.
  if (import.meta.client && window.location.hash === '#sharing') {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }
}, { immediate: true })
// A stored Sharing tab on a board that has none (not the owner, local mode) falls back.
// Waits for both reads (the account and the board's role), or a slow one would reset it.
watch([canShare, () => panel.value.tab, meta, me], ([can, tab, m, who]) => {
  if (!can && tab === 'sharing' && m && who) panel.value.tab = 'findings'
})

/** A link visitor's "Sign in to edit" (an edit link, signed out): sign in, then back here. */
async function signInToEdit() {
  try {
    sessionStorage.setItem(RETURN_KEY, returnEntry(`/b/${id.value}`))
  } catch {
    // No storage (a private window): the user lands on the boards.
  }
  await navigateTo('/login')
}

/** Fork: a copy of this board in my account (signed in, someone else's board). */
const forking = ref(false)
async function forkBoard() {
  if (forking.value) return
  forking.value = true
  try {
    const { id: fresh } = await $fetch<{ id: string }>(`/api/boards/${encodeURIComponent(id.value)}/fork`, { method: 'POST' })
    toast.add({ title: `Forked: ${meta.value?.name ?? 'the board'} is now in your boards`, color: 'success', icon: 'i-lucide-check' })
    await navigateTo(`/b/${fresh}`)
  } catch (e) {
    const data = (e as { data?: { error?: unknown } }).data
    toast.add({ title: typeof data?.error === 'string' ? data.error : `Fork failed: ${(e as Error).message}`, color: 'error', icon: 'i-lucide-ban' })
  } finally {
    forking.value = false
  }
}

/** The link password prompt (GET answered 401). */
const password = ref('')
const unlockError = ref<string | null>(null)
const unlocking = ref(false)
watch(id, () => {
  password.value = ''
  unlockError.value = null
})
async function unlock() {
  if (unlocking.value || password.value === '') return
  unlocking.value = true
  unlockError.value = null
  try {
    await $fetch(`/api/links/${encodeURIComponent(id.value)}/unlock`, { method: 'POST', body: { password: password.value } })
    password.value = ''
    live.retry()
  } catch (e) {
    const data = (e as { data?: { error?: unknown } }).data
    unlockError.value = typeof data?.error === 'string' ? data.error : 'Could not check the password. Try again.'
  } finally {
    unlocking.value = false
  }
}

const STATUS = {
  live: { label: 'live', color: 'success' },
  connecting: { label: 'connecting…', color: 'info' },
  offline: { label: 'offline', color: 'warning' }
} as const

/**
 * The sheet is made from the board as the server holds it, which is what every copy shows;
 * its bottom overviews are turned over the way this viewer picked.
 */
function openBench() {
  window.open(benchUrl(id.value, bottomFlip.value), '_blank', 'noopener')
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const a = pageKey(e.key, view.value, last2d.value)
  if (!a) return
  if ('panel' in a) panel.value.open = !panel.value.open
  // In and out of 3D the canvas keeps its camera; F frames a side.
  else if ('view' in a) {
    if (view.value === '3d' || a.view === '3d') view.value = a.view
    else pickView(a.view)
  } else if (a.zoom === 0) pickView('both')
  else canvas.value?.zoomStep(a.zoom)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const sideTitle = (s: Side) => (s === 'top'
  ? 'Top (parts side)'
  : `Bottom (solder side${mirrorBottom.value ? `, mirrored ${bottomFlip.value === 'tb' ? 'top↔bottom' : 'left↔right'}: seen from below` : ', seen through the board'})`)
</script>

<template>
  <div class="flex h-dvh flex-col overflow-hidden">
    <header class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-default px-4 py-2">
      <NuxtLink
        to="/boards"
        class="flex items-center gap-2"
        title="All boards"
      >
        <img
          src="/icon.svg"
          alt=""
          width="24"
          height="24"
        >
        <span class="font-semibold">WireBender</span>
      </NuxtLink>
      <span
        v-if="board"
        class="font-medium"
      >{{ board.name }}</span>
      <span
        v-if="revision"
        class="font-mono text-sm"
      >rev {{ revision }}</span>
      <UBadge
        :color="STATUS[status].color"
        variant="subtle"
        :icon="status === 'offline' ? 'i-lucide-wifi-off' : undefined"
        :label="STATUS[status].label"
        :title="readOnly ? PAUSED_TITLE : undefined"
      />
      <UButton
        v-if="hiddenN"
        size="xs"
        color="warning"
        variant="soft"
        icon="i-lucide-eye-off"
        :label="`${hiddenN} hidden`"
        title="Some items are hidden from view (in this browser only): open Layers"
        @click="openLayers"
      />
      <PresenceBar :peers="peers" />
      <div class="ml-auto flex gap-1">
        <UButton
          v-if="canShare"
          size="xs"
          variant="ghost"
          icon="i-lucide-share-2"
          label="Share"
          @click="openSharing"
        />
      </div>
      <UTooltip text="Open the printable bench sheet in a new tab">
        <span class="inline-flex">
          <UButton
            size="xs"
            variant="outline"
            icon="i-lucide-printer"
            label="Bench sheet"
            :disabled="missing || noAccess || needsPassword"
            @click="openBench"
          />
        </span>
      </UTooltip>
    </header>

    <UAlert
      v-if="noAccess"
      class="mx-4 mt-3 shrink-0"
      color="error"
      variant="subtle"
      icon="i-lucide-lock"
      :title="NO_ACCESS"
    >
      <template #actions>
        <UButton
          size="xs"
          color="error"
          variant="outline"
          to="/boards"
          label="Back to the board list"
        />
      </template>
    </UAlert>
    <UAlert
      v-else-if="missing"
      class="mx-4 mt-3 shrink-0"
      color="error"
      variant="subtle"
      icon="i-lucide-file-x"
      title="This board doesn't exist"
    >
      <template #actions>
        <UButton
          size="xs"
          color="error"
          variant="outline"
          to="/boards"
          label="Back to the board list"
        />
      </template>
    </UAlert>
    <UAlert
      v-else-if="previewRow"
      class="mx-4 mt-3 shrink-0"
      color="info"
      variant="subtle"
      icon="i-lucide-history"
      :title="previewBanner(previewRow)"
    >
      <template #actions>
        <UButton
          v-if="!viewOnly"
          size="xs"
          label="Restore"
          :loading="restoring"
          :disabled="!canEdit || !previewBoard"
          :title="readOnly ? PAUSED_TITLE : undefined"
          @click="restore"
        />
        <UButton
          size="xs"
          variant="outline"
          label="Back to current"
          @click="previewRow = null"
        />
      </template>
    </UAlert>
    <UAlert
      v-else-if="visiting && meta"
      class="mx-4 mt-3 shrink-0"
      color="neutral"
      variant="subtle"
      :icon="viewOnly ? 'i-lucide-eye' : 'i-lucide-pencil'"
      :title="`Viewing ${board?.name ?? meta.name} by ${meta.owner.name}.`"
      :description="signedIn ? 'The owner can see that you opened this board.' : undefined"
    >
      <template
        v-if="signedIn || meta.signInToEdit"
        #actions
      >
        <UButton
          v-if="meta.signInToEdit && !signedIn"
          size="xs"
          icon="i-lucide-log-in"
          label="Sign in to edit"
          @click="signInToEdit"
        />
        <UButton
          v-else-if="signedIn"
          size="xs"
          variant="outline"
          icon="i-lucide-git-fork"
          label="Fork"
          :loading="forking"
          @click="forkBoard"
        />
      </template>
    </UAlert>

    <div
      v-if="needsPassword"
      class="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6"
    >
      <h1 class="text-lg font-semibold">
        This board's link needs a password
      </h1>
      <p class="text-sm text-muted">
        Ask the person who sent you the link for it.
      </p>
      <form
        class="space-y-3"
        @submit.prevent="unlock"
      >
        <UFormField
          label="Password"
          :error="unlockError ?? undefined"
        >
          <UInput
            v-model="password"
            type="password"
            class="w-full"
            autocomplete="current-password"
            autofocus
          />
        </UFormField>
        <UButton
          type="submit"
          label="Open the board"
          :loading="unlocking"
          :disabled="password === ''"
        />
      </form>
    </div>

    <div
      v-else
      class="flex min-h-0 flex-1 flex-col lg:flex-row"
    >
      <main class="flex min-h-0 min-w-0 flex-1 flex-col border-b border-default lg:border-r lg:border-b-0">
        <p
          v-if="!board || !loaded"
          class="p-4 text-muted"
        >
          {{ missing || noAccess ? 'Nothing to show.' : 'Loading board…' }}
        </p>
        <ClientOnly v-else-if="view === '3d'">
          <!-- A failed 3D load (or a throw while it starts) shows the fallback, not nothing. -->
          <NuxtErrorBoundary>
            <LazyBoard3D
              class="min-h-0 flex-1"
              :board="drawn ?? board"
              :highlight-nets="highlightNets"
              :mark-holes="markHoles"
              :layers="layers"
              @hover-tag="(t: Tag | null) => hoverTag = t"
              @back="view = 'both'"
            >
              <template #controls>
                <Toolbar
                  :view="view"
                  @mode="pickMode"
                />
              </template>
            </LazyBoard3D>
            <template #error="{ error, clearError }">
              <Board3DFallback
                v-bind="fallbackAlert({ kind: 'error', error })"
                @back="view = 'both'; clearError()"
              />
            </template>
          </NuxtErrorBoundary>
        </ClientOnly>
        <div
          v-else
          class="flex min-h-0 flex-1 flex-col"
        >
          <BoardCanvas
            ref="canvas"
            class="min-h-0 flex-1"
            :frames="frames"
            :persist-key="board.name"
            :tool="tool"
            @zoom="(p: number) => zoomPct = p"
          >
            <template #overlay>
              <!-- The 2D / 3D switch, then the framings: the same place as in the 3D view. -->
              <div class="flex items-center gap-3">
                <Toolbar
                  :view="view"
                  @mode="pickMode"
                />
                <div
                  class="flex gap-1"
                  role="group"
                  aria-label="Frame"
                >
                  <UButton
                    v-for="v in FRAMINGS"
                    :key="v.id"
                    size="xs"
                    class="w-20 justify-center"
                    color="neutral"
                    :variant="view === v.id ? 'subtle' : 'soft'"
                    :label="v.label"
                    :title="`${v.label} (${v.key})`"
                    :aria-pressed="view === v.id"
                    @click="pickView(v.id)"
                  />
                </div>
              </div>
            </template>
            <template #overlay-end>
              <CanvasControls
                v-model:mirror-bottom="mirrorBottom"
                v-model:flip="bottomFlip"
                :zoom="zoomPct"
                @zoom-in="canvas?.zoomStep(1)"
                @zoom-out="canvas?.zoomStep(-1)"
                @fit="pickView('both')"
              />
            </template>
            <template #frame="{ frame: f }">
              <BoardSide
                :board="board"
                :side="f.id"
                :mirror="f.id === 'bottom' ? bottomMirror : 'none'"
                :highlight-net="highlight"
                :hover-hole="hover?.hole ?? null"
                :tool="tool"
                :conn="conn ?? undefined"
                :placed="placed"
                :draw-from="drawFrom?.side === f.id ? drawFrom.hole : null"
                :mark-holes="markHoles"
                :layers="layers"
                :hidden="hiddenSet"
                :highlight-lit="litItem"
                @hover="sideEvents[f.id].hover"
                @hole-click="sideEvents[f.id].hole"
                @segment-click="sideEvents[f.id].segment"
              />
            </template>
          </BoardCanvas>
          <!-- While drawing, the hint takes the keys' place (one line either way: no jump). -->
          <p
            v-if="hint"
            class="truncate border-t border-default px-4 py-1 font-mono text-xs"
            :title="hint"
          >
            {{ hint }}
          </p>
          <p
            v-else
            class="truncate border-t border-default px-4 py-1 text-xs text-muted max-md:hidden"
            :title="KEYS"
          >
            {{ KEYS }}
          </p>
        </div>
      </main>

      <SidePanel
        v-if="loaded"
        v-model:open="panel.open"
        v-model:tab="panel.tab"
        :badges="badges"
        :hidden="hiddenTabs"
      >
        <template #findings>
          <FindingsPanel
            v-if="board"
            v-model:selected="picked"
            :board="board"
            :check="check ?? undefined"
            :locked="lockedTitle !== null"
            :locked-title="lockedTitle ?? undefined"
            @add-joint="onAddJoint"
          />
        </template>
        <template #edit>
          <EditPanel
            v-model:tool="tool"
            :layers="layers"
            :can-undo="canUndo"
            :can-redo="canRedo"
            :locked="lockedTitle !== null"
            :locked-title="lockedTitle ?? undefined"
            :view-only="viewOnly"
            @undo="undo"
            @redo="redo"
          />
        </template>
        <template #layers>
          <LayersPanel
            :items="items"
            :state="viewState"
            :picked="pickedItem"
            @change="setView"
            @hover="(k: string | null) => hoverItem = k"
            @pick="(k: string | null) => pickedItem = k"
          />
        </template>
        <template #history>
          <HistoryPanel
            v-model:selected="previewRow"
            :board-id="id"
            :revision="revision"
          />
        </template>
        <template #board>
          <BoardInfoPanel
            :board-id="id"
            :board="live.board.value"
            :meta="meta"
            :revision="revision"
            :active="panel.open && panel.tab === 'board'"
          />
        </template>
        <template #sharing>
          <SharingPanel
            v-if="canShare"
            :board-id="id"
            :active="panel.open && panel.tab === 'sharing'"
            :peer-count="peers.length"
          />
        </template>
      </SidePanel>
    </div>
  </div>
</template>
