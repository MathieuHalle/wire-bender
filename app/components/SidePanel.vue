<script setup lang="ts">
// The side panel: a rail of tab buttons and the open tab next to it. Clicking the open
// tab collapses the panel to the rail; clicking any tab opens that one. From `lg` up the
// rail is a vertical strip on the right edge; below it, a row on top of the panel.
// Each tab's content is the slot named after its id; it stays mounted while hidden, so
// its own state (e.g. the findings' expanded groups) survives a collapse.
import { nextPanel, PANEL_TABS, type PanelTab } from '~/utils/sidePanel'

defineProps<{
  /** A count to show on a tab's icon (e.g. the errors on Findings); 0 shows none. */
  badges?: Partial<Record<PanelTab, number>>
}>()

const open = defineModel<boolean>('open', { required: true })
const tab = defineModel<PanelTab>('tab', { required: true })

function onTab(id: PanelTab) {
  const next = nextPanel({ open: open.value, tab: tab.value }, id)
  tab.value = next.tab
  open.value = next.open
}

const tipOf = (label: string, id: PanelTab) =>
  open.value && tab.value === id ? `Collapse the panel ([)` : label
</script>

<template>
  <aside
    class="flex w-full min-w-0 shrink-0 flex-col gap-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-auto lg:flex-row-reverse lg:self-start"
    aria-label="Side panel"
  >
    <div
      class="flex shrink-0 gap-1 lg:flex-col"
      role="toolbar"
      aria-label="Side panel tabs"
    >
      <UTooltip
        v-for="t in PANEL_TABS"
        :key="t.id"
        :text="tipOf(t.label, t.id)"
        :content="{ side: 'left' }"
      >
        <UButton
          class="relative"
          :icon="t.icon"
          :color="open && tab === t.id ? 'primary' : 'neutral'"
          :variant="open && tab === t.id ? 'soft' : 'ghost'"
          :aria-label="t.label"
          :aria-pressed="open && tab === t.id"
          :aria-controls="`side-panel-${t.id}`"
          @click="onTab(t.id)"
        >
          <span class="lg:sr-only">{{ t.label }}</span>
          <span
            v-if="badges?.[t.id]"
            class="absolute -top-1 -right-1 min-w-4 rounded-full bg-error px-1 text-center text-[10px] leading-4 font-semibold text-inverted"
            :aria-label="`${badges[t.id]} errors`"
          >{{ badges[t.id] }}</span>
        </UButton>
      </UTooltip>
    </div>
    <div
      v-show="open"
      class="min-w-0 lg:w-80 lg:overflow-y-auto"
    >
      <div
        v-for="t in PANEL_TABS"
        v-show="tab === t.id"
        :id="`side-panel-${t.id}`"
        :key="t.id"
      >
        <slot :name="t.id" />
      </div>
    </div>
  </aside>
</template>
