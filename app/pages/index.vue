<script setup lang="ts">
import { parseHole, tryParseHole, type Hole } from '~core/holes'
import type { Side } from '~core/schema'
import { runCheck, type Finding } from '~core/check'
import { tagNets, type Tag } from '~core/scene3d'
import { placePart } from '~core/footprints'
import { buildConnectivity } from '~core/connectivity'
import { jointSide, pageKey, zoomStep, type View } from '~/utils/boardView'
import { fallbackAlert } from '~/utils/board3dFallback'
import { defaultPanel, loadPanel, savePanel, type PanelState } from '~/utils/sidePanel'

const { board, errors, errorKind, path, revision, status, canUndo, canRedo, undo, redo, reloadFromDisk, keepMine } = useBoard()
/** 'both' side by side, one large side (key F flips), or the 3D view (key 3, look only). */
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
/** Shared by both sides so they stay the same scale. */
const zoom = ref(1)

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

/** The side panel: open or collapsed, its tab, and the view layers. Read once mounted (no storage on the server). */
const panel = ref<PanelState>(defaultPanel())
const storage = () => window.localStorage
onMounted(() => {
  panel.value = loadPanel(storage)
  watch(panel, p => savePanel(p, storage), { deep: true })
})
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

const sides = computed<Side[]>(() => (view.value === 'both' || view.value === '3d' ? ['top', 'bottom'] : [view.value]))

function onHover(side: Side, hole: Hole | null) {
  hover.value = hole ? { side, hole } : null
}

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
  else if ('view' in a) view.value = a.view
  else zoom.value = a.zoom === 0 ? 1 : zoomStep(zoom.value, a.zoom)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const sideTitle = (s: Side) => (s === 'top'
  ? 'Top (parts side)'
  : `Bottom (solder side${mirrorBottom.value ? ', mirrored: seen from below' : ', seen through the board'})`)
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-default px-4 py-2">
      <img
        src="/icon.svg"
        alt=""
        width="18"
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

    <Toolbar
      v-model:view="view"
      v-model:mirror-bottom="mirrorBottom"
      v-model:zoom="zoom"
      :hint="hint"
    />

    <UAlert
      v-if="status === 'conflict'"
      class="mx-4 mt-3"
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
      class="mx-4 mt-3"
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

    <div class="flex flex-1 flex-col gap-4 p-4 lg:flex-row">
      <main class="min-w-0 flex-1">
        <p
          v-if="!board"
          class="text-muted"
        >
          Loading board…
        </p>
        <ClientOnly v-else-if="view === '3d'">
          <!-- A failed 3D load (or a throw while it starts) shows the fallback, not nothing. -->
          <NuxtErrorBoundary>
            <LazyBoard3D
              :board="board"
              :highlight-nets="highlightNets"
              :mark-holes="markHoles"
              :layers="panel.layers"
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
          class="grid gap-4"
          :class="view === 'both' ? 'md:grid-cols-2' : 'mx-auto max-w-4xl'"
        >
          <section
            v-for="s in sides"
            :key="s"
            class="min-w-0"
          >
            <h2 class="mb-1 text-sm font-medium text-muted">
              {{ sideTitle(s) }}
            </h2>
            <BoardSide
              :board="board"
              :side="s"
              :mirrored="s === 'bottom' && mirrorBottom"
              :highlight-net="highlight"
              :hover-hole="hover?.hole ?? null"
              :tool="tool"
              :conn="conn ?? undefined"
              :placed="placed"
              :draw-from="drawFrom?.side === s ? drawFrom.hole : null"
              :mark-holes="markHoles"
              :zoom="zoom"
              :layers="panel.layers"
              @hover="(h: Hole | null) => onHover(s, h)"
              @hole-click="(h: Hole) => onHoleClick(s, h)"
              @segment-click="(a: Hole, b: Hole) => onSegmentClick(s, a, b)"
            />
          </section>
        </div>
      </main>

      <SidePanel
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
