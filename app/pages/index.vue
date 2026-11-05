<script setup lang="ts">
import type { Hole } from '~core/holes'
import type { Side } from '~core/schema'
import { placePart } from '~core/footprints'
import { buildConnectivity } from '~core/connectivity'
import { runCheck } from '~core/check'
import { ADVISORY, groupFindings, type FindingGroup } from '~~/cli/format'
import { holeGroups, type Tool } from '~/utils/boardView'

const { board, errors, path, revision, status, canUndo, canRedo, undo, redo } = useBoard()

const mirrorBottom = ref(true)
/** 'both' side by side, or one large side (key F flips). */
const view = ref<'both' | Side>('both')
const tool = ref<Tool>('select')

const placed = computed(() => board.value?.parts.map(placePart) ?? [])
const conn = computed(() => (board.value ? buildConnectivity(board.value) : null))
const groupsAt = computed(() => (board.value && conn.value ? holeGroups(board.value, conn.value, placed.value) : null))
const check = computed(() => (board.value ? runCheck(board.value) : null))
const showAll = ref(false)
/** Harmless cautions are collapsed, as in the CLI, until asked for. */
const shown = (g: FindingGroup) => (g.tag === 'CAUTION [harmless]' && !showAll.value ? g.findings.slice(0, 3) : g.findings)
const findingGroups = computed(() => (check.value ? groupFindings(check.value.findings) : []))

const hover = ref<{ side: Side, hole: Hole } | null>(null)
const highlight = computed(() => {
  const h = hover.value
  if (!h || !groupsAt.value || !conn.value) return null
  const gi = groupsAt.value.get(`${h.hole.col},${h.hole.row}|${h.side}`)
  return gi === undefined ? null : conn.value.groups[gi]!
})

const sides = computed<Side[]>(() => (view.value === 'both' ? ['top', 'bottom'] : [view.value]))

function onHover(side: Side, hole: Hole | null) {
  hover.value = hole ? { side, hole } : null
}

const STATUS = {
  saved: { label: 'saved', color: 'success' },
  saving: { label: 'saving…', color: 'info' },
  conflict: { label: 'conflict', color: 'warning' },
  error: { label: 'error', color: 'error' }
} as const

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'f' || e.key === 'F') {
    view.value = view.value === 'top' ? 'bottom' : 'top'
  }
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
    </header>

    <div class="flex flex-wrap items-center gap-4 border-b border-default px-4 py-2 text-sm">
      <div class="flex gap-1">
        <UButton
          size="xs"
          :variant="view === 'both' ? 'solid' : 'outline'"
          label="Both sides"
          @click="view = 'both'"
        />
        <UButton
          size="xs"
          :variant="view === 'top' ? 'solid' : 'outline'"
          label="Top"
          @click="view = 'top'"
        />
        <UButton
          size="xs"
          :variant="view === 'bottom' ? 'solid' : 'outline'"
          label="Bottom"
          @click="view = 'bottom'"
        />
      </div>
      <USwitch
        v-model="mirrorBottom"
        label="Mirror bottom"
      />
      <div class="flex gap-1">
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-undo-2"
          aria-label="Undo"
          :disabled="!canUndo"
          @click="undo"
        />
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-redo-2"
          aria-label="Redo"
          :disabled="!canRedo"
          @click="redo"
        />
      </div>
      <span class="text-xs text-muted">F: one large side, flip</span>
    </div>

    <UAlert
      v-if="errors.length"
      class="mx-4 mt-3"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="board ? 'The board file has errors. Showing the last good version.' : 'The board file has errors.'"
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
              @hover="(h: Hole | null) => onHover(s, h)"
            />
          </section>
        </div>
      </main>

      <aside class="w-full shrink-0 text-sm lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-80 lg:self-start lg:overflow-y-auto">
        <h2 class="mb-2 font-medium">
          Findings
        </h2>
        <template v-if="check">
          <div
            v-for="g in findingGroups"
            :key="g.tag"
            class="mb-3"
          >
            <div class="font-mono text-xs font-semibold">
              {{ g.tag }} ({{ g.findings.length }})
            </div>
            <ul class="mt-1 space-y-1">
              <li
                v-for="(f, i) in shown(g)"
                :key="i"
                class="text-xs"
              >
                <span class="font-mono text-muted">{{ f.holes.slice(0, 3).join(' ') }}</span>
                {{ f.message }}
              </li>
            </ul>
            <UButton
              v-if="shown(g).length < g.findings.length"
              size="xs"
              variant="link"
              :label="`${g.findings.length - shown(g).length} more`"
              @click="showAll = true"
            />
          </div>
          <p
            v-if="!findingGroups.length"
            class="text-xs text-muted"
          >
            No findings.
          </p>
        </template>
        <p class="mt-3 text-xs font-medium">
          {{ ADVISORY }}
        </p>
      </aside>
    </div>
  </div>
</template>
