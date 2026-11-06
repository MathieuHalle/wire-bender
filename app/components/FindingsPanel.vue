<script setup lang="ts">
// The live check: runCheck on every board change, grouped like the CLI. Clicking a finding
// highlights its holes on both sides (click it again to clear). Ends with the advisory.
import type { BoardFile } from '~core/schema'
import { runCheck, type CheckResult, type Finding } from '~core/check'
import { ADVISORY, groupFindings, statsLine } from '~~/cli/format'
import { lockedAttrs } from '~/utils/boardView'

const props = defineProps<{
  board: BoardFile
  /** The 3D view is showing: no edits, so "Add joint" is off. */
  locked?: boolean
  /** The check of `board`, when the page has already run it (it also counts the errors for the tab). */
  check?: CheckResult
}>()
const emit = defineEmits<{ 'add-joint': [finding: Finding] }>()
/** The finding whose holes are highlighted. */
const selected = defineModel<Finding | null>('selected', { default: null })

const check = computed(() => props.check ?? runCheck(props.board))
const groups = computed(() => groupFindings(check.value.findings))
const byTag = (tag: string) => groups.value.find(g => g.tag === tag)?.findings ?? []

const CAUTIONS = [
  { tag: 'CAUTION [supply]', label: 'Shorts the supply' },
  { tag: 'CAUTION [mcu]', label: 'Kills the MCU' },
  { tag: 'CAUTION [harmless]', label: 'Harmless' }
]

interface Block { tag: string, label: string, findings: Finding[], collapsible: boolean }
interface Section { id: string, label: string, color: string, count: number, blocks: Block[] }

const sections = computed<Section[]>(() => {
  const one = (tag: string): Block[] => [{ tag, label: '', findings: byTag(tag), collapsible: false }]
  const cautions: Block[] = CAUTIONS
    .map(c => ({ ...c, findings: byTag(c.tag), collapsible: c.tag === 'CAUTION [harmless]' }))
    .filter(b => b.findings.length)
  return ([
    { id: 'error', label: 'Errors', color: 'text-error', blocks: one('ERROR') },
    { id: 'warning', label: 'Warnings', color: 'text-warning', blocks: one('WARNING') },
    { id: 'caution', label: 'Cautions', color: 'text-info', blocks: cautions }
  ]).map(s => ({ ...s, count: s.blocks.reduce((n, b) => n + b.findings.length, 0) }))
    .filter(s => s.count)
})

/** Harmless cautions start collapsed. */
const showHarmless = ref(false)
const open = (b: Block) => !b.collapsible || showHarmless.value

const keyOf = (f: Finding) => `${f.rule}|${f.holes.join(',')}|${f.message}`
const isSelected = (f: Finding) => selected.value !== null && keyOf(selected.value) === keyOf(f)
function pick(f: Finding) {
  selected.value = isSelected(f) ? null : f
}

// Keep the selection pointing at the current finding; drop it once the finding is gone.
watch(check, (c) => {
  const s = selected.value
  if (!s) return
  selected.value = c.findings.find(f => keyOf(f) === keyOf(s)) ?? null
})
</script>

<template>
  <div class="text-sm">
    <h2 class="mb-2 text-lg font-medium">
      Findings
    </h2>
    <p class="mb-3 font-mono text-xs text-muted">
      {{ statsLine(check.stats) }}
    </p>

    <section
      v-for="s in sections"
      :key="s.id"
      class="mb-3"
    >
      <h3
        class="text-xs font-semibold"
        :class="s.color"
      >
        {{ s.label }} ({{ s.count }})
      </h3>
      <div
        v-for="b in s.blocks"
        :key="b.tag"
        :class="b.label ? 'mt-2' : ''"
      >
        <button
          v-if="b.collapsible"
          type="button"
          class="flex items-center gap-1 text-xs font-medium text-muted hover:text-default"
          :aria-expanded="showHarmless"
          @click="showHarmless = !showHarmless"
        >
          <UIcon :name="showHarmless ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
          {{ b.label }} ({{ b.findings.length }})
        </button>
        <div
          v-else-if="b.label"
          class="text-xs font-medium text-muted"
        >
          {{ b.label }} ({{ b.findings.length }})
        </div>
        <ul
          v-if="open(b)"
          class="mt-1 space-y-1"
        >
          <li
            v-for="f in b.findings"
            :key="keyOf(f)"
            class="rounded px-1 py-0.5 text-xs"
            :class="isSelected(f) ? 'bg-elevated ring-1 ring-error' : 'hover:bg-elevated/60'"
          >
            <button
              type="button"
              class="w-full cursor-pointer text-left"
              :aria-pressed="isSelected(f)"
              @click="pick(f)"
            >
              <span class="font-mono text-muted">{{ f.holes.slice(0, 3).join(' ') }}<span v-if="f.holes.length > 3"> …</span></span>
              {{ f.message }}
            </button>
            <UButton
              v-if="f.rule === 'missingJoint'"
              class="mt-0.5"
              size="xs"
              variant="soft"
              icon="i-lucide-circle-dot"
              label="Add joint"
              v-bind="lockedAttrs(locked)"
              @click="locked || emit('add-joint', f)"
            />
          </li>
        </ul>
      </div>
    </section>

    <p
      v-if="!sections.length"
      class="text-xs text-muted"
    >
      No findings.
    </p>
    <p class="mt-3 border-t border-default pt-2 text-xs font-medium">
      {{ ADVISORY }}
    </p>
  </div>
</template>
