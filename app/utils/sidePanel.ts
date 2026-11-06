// The side panel's state: open or collapsed, the active tab, and the view layers. Kept in
// localStorage; every access is guarded, since storage can be blocked, full or tampered with.
import { ALL_LAYERS, type Layers } from './layers'

export const PANEL_KEY = 'wirebender:sidepanel'

/** The tabs, in rail order. Add a tab here (and its slot in the page). */
export const PANEL_TABS = [
  { id: 'findings', label: 'Findings', icon: 'i-lucide-list-checks' },
  { id: 'edit', label: 'Edit', icon: 'i-lucide-pencil-ruler' }
] as const

export type PanelTab = (typeof PANEL_TABS)[number]['id']

export interface PanelState {
  open: boolean
  tab: PanelTab
  layers: Layers
}

/** What the storage functions need from `localStorage`. */
export type PanelStorage = Pick<Storage, 'getItem' | 'setItem'>

export function defaultPanel(): PanelState {
  return { open: true, tab: 'findings', layers: { ...ALL_LAYERS } }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTab = (v: unknown): v is PanelTab => PANEL_TABS.some(t => t.id === v)

/** The stored text as a state: each field that is missing or of the wrong type takes its default. */
export function parsePanel(raw: string | null): PanelState {
  const d = defaultPanel()
  if (!raw) return d
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return d
  }
  if (!isRecord(v)) return d
  const l = isRecord(v.layers) ? v.layers : {}
  const flag = (x: unknown, fallback: boolean) => (typeof x === 'boolean' ? x : fallback)
  return {
    open: flag(v.open, d.open),
    tab: isTab(v.tab) ? v.tab : d.tab,
    layers: {
      components: flag(l.components, d.layers.components),
      wires: flag(l.wires, d.layers.wires),
      trails: flag(l.trails, d.layers.trails)
    }
  }
}

/** Reads the state; `storage` is a getter because reading `window.localStorage` itself can throw. */
export function loadPanel(storage: () => PanelStorage | null | undefined): PanelState {
  try {
    const s = storage()
    return s ? parsePanel(s.getItem(PANEL_KEY)) : defaultPanel()
  } catch {
    return defaultPanel()
  }
}

/** Writes the state; false when storage is missing or refuses it. */
export function savePanel(state: PanelState, storage: () => PanelStorage | null | undefined): boolean {
  try {
    const s = storage()
    if (!s) return false
    s.setItem(PANEL_KEY, JSON.stringify({ open: state.open, tab: state.tab, layers: { ...state.layers } }))
    return true
  } catch {
    return false
  }
}
