<script setup lang="ts">
// The side panel's Layers tab: the view layers as group rows (Components, Wires, Trails),
// each with a row per item to hide or show it alone. Hovering a row lights the item on
// the board; clicking it rings its holes, as a finding does. A viewing aid only, in this
// browser: the board, its revisions, the check and the printouts always have everything.
import {
  groupState, hiddenCount, isShown, matchItems, setShown, showAll, toggleGroup,
  type BoardItem, type BoardItems, type GroupState, type ItemKind, type ViewState
} from '~/utils/hiddenItems'

const props = defineProps<{
  items: BoardItems
  /** The layers and this board's hidden keys. */
  state: ViewState
  /** The item whose holes are ringed. */
  picked?: string | null
}>()
const emit = defineEmits<{
  change: [state: ViewState]
  hover: [key: string | null]
  pick: [key: string | null]
}>()

const GROUPS: { kind: ItemKind, label: string, description: string }[] = [
  { kind: 'part', label: 'Components', description: 'Part bodies, labels and legs' },
  { kind: 'wire', label: 'Wires', description: 'Insulated wires, laid and flying' },
  { kind: 'trail', label: 'Trails', description: 'Bare trails, their joints, leg-folds, bridges' }
]

const filter = ref('')
const filtering = computed(() => filter.value.trim() !== '')
/** Collapsed groups; while filtering every group with a match is open. */
const collapsed = ref(new Set<ItemKind>())
function toggleCollapsed(kind: ItemKind) {
  const s = new Set(collapsed.value)
  if (!s.delete(kind)) s.add(kind)
  collapsed.value = s
}

const hiddenSet = computed(() => new Set(props.state.hidden))
const count = computed(() => hiddenCount(props.items, props.state))

const groups = computed(() => GROUPS.map((g) => {
  const all = props.items[g.kind]
  const rows = matchItems(all, filter.value).map(i => ({ ...i, shown: isShown(i, props.state, hiddenSet.value) }))
  const state = groupState(g.kind, all, props.state)
  return { ...g, all, rows, state, hidden: all.filter(i => !isShown(i, props.state, hiddenSet.value)).length }
}).filter(g => !filtering.value || g.rows.length))

const EYE: Record<GroupState, string> = { shown: 'i-lucide-eye', hidden: 'i-lucide-eye-off', mixed: 'i-lucide-eye' }
const ARIA: Record<GroupState, 'true' | 'false' | 'mixed'> = { shown: 'true', hidden: 'false', mixed: 'mixed' }

function onGroup(kind: ItemKind, items: BoardItem[]) {
  emit('change', toggleGroup(kind, items, props.state))
}
function onItem(item: BoardItem & { shown: boolean }) {
  emit('change', setShown([item.key], !item.shown, props.items, props.state))
}
function onShowAll() {
  emit('change', showAll(props.state))
}
function onPick(key: string) {
  emit('pick', props.picked === key ? null : key)
}
</script>

<template>
  <div class="text-sm">
    <h2 class="mb-1 text-lg font-medium">
      Layers
    </h2>
    <p class="mb-2 text-xs text-muted">
      View only, in this browser: the board, the check and the printouts show everything. Holes and pads always show.
    </p>
    <div class="mb-2 flex items-center gap-2">
      <UInput
        v-model="filter"
        size="xs"
        class="min-w-0 flex-1"
        icon="i-lucide-search"
        placeholder="Filter by name"
        aria-label="Filter the items by name"
      />
      <UButton
        size="xs"
        variant="outline"
        icon="i-lucide-eye"
        label="Show all"
        :disabled="count === 0"
        @click="onShowAll"
      />
    </div>
    <p
      v-if="count"
      class="mb-2 text-xs text-warning"
      role="status"
    >
      {{ count }} hidden
    </p>

    <section
      v-for="g in groups"
      :key="g.kind"
      class="mb-2"
    >
      <div class="flex items-center gap-1">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          :icon="collapsed.has(g.kind) && !filtering ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
          :aria-label="`${collapsed.has(g.kind) ? 'Expand' : 'Collapse'} ${g.label}`"
          :aria-expanded="!collapsed.has(g.kind) || filtering"
          @click="toggleCollapsed(g.kind)"
        />
        <button
          type="button"
          class="min-w-0 flex-1 cursor-pointer text-left"
          @click="toggleCollapsed(g.kind)"
        >
          <span class="font-medium">{{ g.label }}</span>
          <span class="text-xs text-muted"> ({{ g.all.length }}<template v-if="g.state === 'mixed'">, {{ g.hidden }} hidden</template>)</span>
          <span class="block truncate text-xs text-muted">{{ g.description }}</span>
        </button>
        <UButton
          size="xs"
          variant="ghost"
          :color="g.state === 'shown' ? 'neutral' : 'warning'"
          :icon="EYE[g.state]"
          :class="g.state === 'mixed' ? 'opacity-60' : ''"
          role="checkbox"
          :aria-checked="ARIA[g.state]"
          :aria-label="g.state === 'shown' ? `Hide all ${g.label}` : `Show all ${g.label}`"
          :title="g.state === 'shown' ? `Hide all ${g.label}` : `Show all ${g.label}`"
          @click="onGroup(g.kind, g.all)"
        />
      </div>
      <ul
        v-if="!collapsed.has(g.kind) || filtering"
        class="mt-0.5 ml-6"
      >
        <li
          v-for="i in g.rows"
          :key="i.key"
          class="flex items-center gap-1 rounded px-1 text-xs"
          :class="picked === i.key ? 'bg-elevated ring-1 ring-primary' : 'hover:bg-elevated/60'"
          @mouseenter="emit('hover', i.key)"
          @mouseleave="emit('hover', null)"
        >
          <button
            type="button"
            class="min-w-0 flex-1 cursor-pointer truncate py-0.5 text-left"
            :class="i.shown ? '' : 'text-muted line-through'"
            :aria-pressed="picked === i.key"
            :title="`Ring ${i.label} on the board`"
            @click="onPick(i.key)"
          >
            <span class="font-mono">{{ i.label }}</span>
            <span
              v-if="i.detail"
              class="ml-1 text-muted"
            >{{ i.detail }}</span>
          </button>
          <UButton
            size="xs"
            variant="ghost"
            :color="i.shown ? 'neutral' : 'warning'"
            :icon="i.shown ? 'i-lucide-eye' : 'i-lucide-eye-off'"
            :aria-label="`${i.shown ? 'Hide' : 'Show'} ${i.label}`"
            :aria-pressed="!i.shown"
            :title="i.shown ? 'Hide' : 'Show'"
            @click="onItem(i)"
          />
        </li>
        <li
          v-if="!g.rows.length"
          class="px-1 text-xs text-muted"
        >
          None on this board.
        </li>
      </ul>
    </section>
    <p
      v-if="filtering && !groups.length"
      class="text-xs text-muted"
    >
      Nothing matches “{{ filter.trim() }}”.
    </p>
  </div>
</template>
