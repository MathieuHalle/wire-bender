<script setup lang="ts">
import { parseHole, tryParseHole, type Hole } from '~core/holes'
import type { Side } from '~core/schema'
import { runCheck, type Finding } from '~core/check'
import { tagNets, type Tag } from '~core/scene3d'
import { placePart } from '~core/footprints'
import { buildConnectivity } from '~core/connectivity'
import { jointSide, makeGeo, pageKey, sideBox, sideFrames, type View } from '~/utils/boardView'
import { fallbackAlert } from '~/utils/board3dFallback'
import { defaultPanel, loadPanel, savePanel, type PanelState } from '~/utils/sidePanel'
import { ALL_LAYERS } from '~/utils/layers'

const { board, errors, errorKind, path, revision, status, canUndo, canRedo, undo, redo, reloadFromDisk, keepMine } = useBoard()
/**
 * What the canvas was last framed on: both sides, one side (key F flips), or the 3D view
 * (key 3, look only). In 2D a view is a camera move; the user can pan away from it.
 */
const view = ref<View>('both')
const { tool, drawing, onHoleClick, onSegmentClick, addJoint, endDrawing } = useTools({ locked: () => view.value === '3d' })
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
  if (view.value === '3d') return
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

const STATUS = {
  saved: { label: 'saved', color: 'success' },
  saving: { label: 'saving…', color: 'info' },
  conflict: { label: 'conflict', color: 'warning' },
  error: { label: 'error', color: 'error' }
} as const

/** The errors come from parsing the file (not from a lost server or a failed save). */
const fileBroken = computed(() => errors.value.length > 0 && errorKind.value === 'file')
const errorTitle = computed(() => {
  if (errorKind.value === 'save') return 'Saving failed. Your edits are kept here and saved again once the server answers.'
  if (errorKind.value === 'server') return 'Cannot reach the WireBender server.'
  return board.value ? 'The board file has errors. Showing the last good version.' : 'The board file has errors.'
})

/** The sheet is made from the file on disk: not while it disagrees with what is shown. */
const benchBlocked = computed(() => !board.value || status.value === 'conflict' || status.value === 'error')
const benchTip = computed(() => {
  if (status.value === 'conflict') return 'Resolve the conflict first: the sheet is made from the file on disk.'
  if (status.value === 'error') return 'Fix the error first: the sheet is made from the file on disk.'
  return 'Open the printable bench sheet in a new tab'
})

/** Opens /api/bench once any pending save is on disk, so the sheet shows the latest edit. */
function openBench() {
  if (benchBlocked.value) return
  if (status.value === 'saved') {
    window.open('/api/bench', '_blank', 'noopener')
    return
  }
  // Open the tab now, inside the click, so popup blockers allow it; point it at the sheet after the save.
  const tab = window.open('', '_blank')
  if (tab) tab.document.title = 'Waiting for the save…'
  const stop = watch(status, (s) => {
    if (s === 'saving') return
    stop()
    if (s === 'saved' && tab) tab.location.href = '/api/bench'
    else tab?.close()
  })
}

/** "Load the file" asks again inside the banner before discarding local edits. */
const confirmLoad = ref(false)
watch(status, (s) => {
  if (s !== 'conflict') confirmLoad.value = false
})

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
      <img
        src="/icon.svg"
        alt=""
        width="24"
        height="24"
      >
      <span class="font-semibold">WireBender</span>
      <span
        v-if="board"
        class="font-medium"
      >{{ board.name }}</span>
      <span
        class="max-w-[40ch] truncate font-mono text-xs text-muted"
        :title="path"
      >{{ path }}</span>
      <span class="font-mono text-sm">rev {{ revision }}</span>
      <UBadge
        :color="STATUS[status].color"
        variant="subtle"
        :label="STATUS[status].label"
      />
      <Toolbar
        :view="view"
        @mode="pickMode"
      />
      <UTooltip :text="benchTip">
        <span class="ml-auto inline-flex">
          <UButton
            size="xs"
            variant="outline"
            icon="i-lucide-printer"
            label="Bench sheet"
            :disabled="benchBlocked"
            @click="openBench"
          />
        </span>
      </UTooltip>
    </header>

    <UAlert
      v-if="status === 'conflict'"
      class="mx-4 mt-3 max-h-[30dvh] shrink-0 overflow-y-auto"
      color="warning"
      variant="subtle"
      icon="i-lucide-file-warning"
      title="The board file changed on disk while you were editing."
      :description="confirmLoad
        ? 'Loading the file discards the edits you made here since the last save.'
        : 'Load the file to take the version on disk, or keep your version to save it over the file.'"
    >
      <template #actions>
        <template v-if="!confirmLoad">
          <UButton
            size="xs"
            color="warning"
            variant="outline"
            label="Load the file"
            @click="confirmLoad = true"
          />
          <UButton
            size="xs"
            color="warning"
            label="Keep my version"
            @click="keepMine"
          />
        </template>
        <template v-else>
          <UButton
            size="xs"
            color="error"
            label="Discard my edits and load"
            @click="confirmLoad = false; reloadFromDisk()"
          />
          <UButton
            size="xs"
            variant="ghost"
            label="Cancel"
            @click="confirmLoad = false"
          />
        </template>
      </template>
    </UAlert>

    <UAlert
      v-if="errors.length"
      class="mx-4 mt-3 max-h-[30dvh] shrink-0 overflow-y-auto"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorTitle"
    >
      <template #description>
        <ul class="font-mono text-xs">
          <li
            v-for="e in errors"
            :key="e"
          >
            {{ e }}
          </li>
        </ul>
        <p
          v-if="fileBroken"
          class="mt-2 text-xs"
        >
          Fix the file (or ask Claude to); it reloads here on its own once it parses.
        </p>
      </template>
    </UAlert>

    <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <main class="flex min-h-0 min-w-0 flex-1 flex-col border-b border-default lg:border-r lg:border-b-0">
        <p
          v-if="!board || !loaded"
          class="p-4 text-muted"
        >
          Loading board…
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
            :locked="view === '3d'"
            @add-joint="onAddJoint"
          />
        </template>
        <template #edit>
          <EditPanel
            v-model:tool="tool"
            v-model:layers="panel.layers"
            :can-undo="canUndo"
            :can-redo="canRedo"
            :locked="view === '3d'"
            @undo="undo"
            @redo="redo"
          />
        </template>
      </SidePanel>
    </div>
  </div>
</template>
