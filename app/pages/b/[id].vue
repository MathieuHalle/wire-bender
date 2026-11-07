<script setup lang="ts">
import { parseHole, tryParseHole, type Hole } from '~core/holes'
import type { BoardFile, Side } from '~core/schema'
import { PREVIEW_TITLE, previewBanner, type RevisionRow } from '~/utils/history'
import { runCheck, type Finding } from '~core/check'
import { tagNets, type Tag } from '~core/scene3d'
import { placePart } from '~core/footprints'
import { buildConnectivity } from '~core/connectivity'
import { jointSide, LOCKED_TITLE, makeGeo, PAUSED_TITLE, pageKey, sideBox, sideFrames, type View } from '~/utils/boardView'
import { fallbackAlert } from '~/utils/board3dFallback'
import { defaultPanel, loadPanel, savePanel, type PanelState } from '~/utils/sidePanel'
import { ALL_LAYERS } from '~/utils/layers'

const route = useRoute()
const id = computed(() => String(route.params.id))
const live = useLiveBoard(id)
const { status, readOnly, missing, revision, canUndo, canRedo, peers, undo, redo } = live

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
  if (!row || restoring.value || readOnly.value) return
  restoring.value = true
  try {
    await $fetch(`/api/boards/${encodeURIComponent(id.value)}/revisions/${row.n}/restore`, { method: 'POST' })
    previewRow.value = null
  } catch {
    toast.add({ title: `Restoring #${row.n} failed.`, color: 'warning', icon: 'i-lucide-ban' })
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
const highlightNets = computed(() => tagNets(hoverTag.value))

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
  loaded.value = true
  watch(panel, p => savePanel(p, storage), { deep: true })
})
/** The layers the views draw: the stored ones once loaded. */
const layers = computed(() => (loaded.value ? panel.value.layers : ALL_LAYERS))
/** Run once here: the Findings tab lists it and its icon counts the errors. */
const check = computed(() => (board.value ? runCheck(board.value) : null))
const badges = computed(() => ({ findings: check.value?.stats.errors ?? 0 }))

/** The finding picked in the panel; its holes are ringed on both sides. */
const picked = ref<Finding | null>(null)
/** Names that don't parse are skipped: a finding never breaks the drawing. */
const markHoles = computed(() => picked.value?.holes.flatMap(n => tryParseHole(n) ?? []) ?? [])

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
const sideEvents = Object.fromEntries((['top', 'bottom'] as const).map(s => [s, {
  hover: (h: Hole | null) => onHover(s, h),
  hole: (h: Hole) => onHoleClick(s, h),
  segment: (a: Hole, b: Hole) => onSegmentClick(s, a, b)
}])) as Record<Side, { hover(h: Hole | null): void, hole(h: Hole): void, segment(a: Hole, b: Hole): void }>

/** The two sides as frames on the canvas, in mm: top on the left, bottom on the right. */
const frames = computed(() => {
  const b = board.value
  if (!b) return []
  const size = (s: Side) => {
    const box = sideBox(makeGeo(b, s === 'bottom' && mirrorBottom.value), placed.value)
    return { w: box.w, h: box.h }
  }
  const at = sideFrames({ top: size('top'), bottom: size('bottom') })
  return (['top', 'bottom'] as const).map(s => ({ id: s, title: sideTitle(s), rect: at[s] }))
})

/** The "Pair a device" and "Paired devices" dialogs. */
const pairing = ref(false)
const devicesOpen = ref(false)

const STATUS = {
  live: { label: 'live', color: 'success' },
  connecting: { label: 'connecting…', color: 'info' },
  offline: { label: 'offline', color: 'warning' }
} as const

/** The sheet is made from the board as the server holds it, which is what every copy shows. */
function openBench() {
  window.open(`/api/boards/${encodeURIComponent(id.value)}/bench`, '_blank', 'noopener')
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
  : `Bottom (solder side${mirrorBottom.value ? ', mirrored: seen from below' : ', seen through the board'})`)
</script>

<template>
  <div class="flex h-dvh flex-col overflow-hidden">
    <header class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-default px-4 py-2">
      <NuxtLink
        to="/"
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
        :label="STATUS[status].label"
      />
      <PresenceBar :peers="peers" />
      <Toolbar
        :view="view"
        @mode="pickMode"
      />
      <div class="ml-auto flex gap-1">
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-tablet-smartphone"
          label="Pair a device"
          @click="pairing = true"
        />
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-monitor-smartphone"
          label="Paired devices"
          @click="devicesOpen = true"
        />
      </div>
      <UTooltip text="Open the printable bench sheet in a new tab">
        <span class="inline-flex">
          <UButton
            size="xs"
            variant="outline"
            icon="i-lucide-printer"
            label="Bench sheet"
            :disabled="missing"
            @click="openBench"
          />
        </span>
      </UTooltip>
      <PairDialog v-model:open="pairing" />
      <DevicesDialog v-model:open="devicesOpen" />
    </header>

    <UAlert
      v-if="missing"
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
          to="/"
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
          size="xs"
          label="Restore"
          :loading="restoring"
          :disabled="readOnly || !previewBoard"
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
      v-else-if="board && readOnly"
      class="mx-4 mt-3 shrink-0"
      color="warning"
      variant="subtle"
      icon="i-lucide-wifi-off"
      :title="PAUSED_TITLE"
    />

    <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <main class="flex min-h-0 min-w-0 flex-1 flex-col border-b border-default lg:border-r lg:border-b-0">
        <p
          v-if="!board || !loaded"
          class="p-4 text-muted"
        >
          {{ missing ? 'Nothing to show.' : 'Loading board…' }}
        </p>
        <ClientOnly v-else-if="view === '3d'">
          <!-- A failed 3D load (or a throw while it starts) shows the fallback, not nothing. -->
          <NuxtErrorBoundary>
            <LazyBoard3D
              class="min-h-0 flex-1"
              :board="board"
              :highlight-nets="highlightNets"
              :mark-holes="markHoles"
              :layers="layers"
              @hover-tag="(t: Tag | null) => hoverTag = t"
              @back="view = 'both'"
            />
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
              <div
                class="flex gap-1"
                role="group"
                aria-label="Frame"
              >
                <UButton
                  v-for="v in FRAMINGS"
                  :key="v.id"
                  size="xs"
                  color="neutral"
                  :variant="view === v.id ? 'solid' : 'outline'"
                  :label="v.label"
                  :title="`${v.label} (${v.key})`"
                  @click="pickView(v.id)"
                />
              </div>
            </template>
            <template #overlay-end>
              <CanvasControls
                v-model:mirror-bottom="mirrorBottom"
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
                :mirrored="f.id === 'bottom' && mirrorBottom"
                :highlight-net="highlight"
                :hover-hole="hover?.hole ?? null"
                :tool="tool"
                :conn="conn ?? undefined"
                :placed="placed"
                :draw-from="drawFrom?.side === f.id ? drawFrom.hole : null"
                :mark-holes="markHoles"
                :layers="layers"
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
            v-model:layers="panel.layers"
            :can-undo="canUndo"
            :can-redo="canRedo"
            :locked="lockedTitle !== null"
            :locked-title="lockedTitle ?? undefined"
            @undo="undo"
            @redo="redo"
          />
        </template>
        <template #history>
          <HistoryPanel
            v-model:selected="previewRow"
            :board-id="id"
            :revision="revision"
          />
        </template>
      </SidePanel>
    </div>
  </div>
</template>
