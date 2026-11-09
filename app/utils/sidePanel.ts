// The side panel's state: open or collapsed, the active tab, and the view layers (the
// Layers tab's group switches). Kept in
// localStorage; every access is guarded, since storage can be blocked, full or tampered with.
import { ALL_LAYERS, type Layers } from './layers'

export const PANEL_KEY = 'wirebender:sidepanel'

/** The tabs, in rail order. Add a tab here (and its slot in the page). */
export const PANEL_TABS = [
  { id: 'findings', label: 'Findings', icon: 'i-lucide-list-checks' },
  { id: 'edit', label: 'Edit', icon: 'i-lucide-pencil-ruler' },
  { id: 'layers', label: 'Layers', icon: 'i-lucide-layers' },
  { id: 'history', label: 'History', icon: 'i-lucide-history' },
  { id: 'board', label: 'Board', icon: 'i-lucide-info' }
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

/**
 * The stored text as a state: each field that is missing or of the wrong type takes its
 * default from `d` (the page passes a collapsed default on narrow screens).
 */
export function parsePanel(raw: string | null, d: PanelState = defaultPanel()): PanelState {
  if (!raw) return { ...d, layers: { ...d.layers } }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { ...d, layers: { ...d.layers } }
  }
  if (!isRecord(v)) return { ...d, layers: { ...d.layers } }
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

/**
 * A click on a tab: the open tab collapses the panel (keeping its tab), any other click
 * opens that tab. Returns a new state; the rest of it (e.g. the layers) is carried over.
 */
export function nextPanel<S extends Pick<PanelState, 'open' | 'tab'>>(state: S, id: PanelTab): S {
  return state.open && state.tab === id ? { ...state, open: false } : { ...state, open: true, tab: id }
}

/**
 * Reads the state, else `d`; `storage` is a getter because reading `window.localStorage`
 * itself can throw.
 */
export function loadPanel(storage: () => PanelStorage | null | undefined, d: PanelState = defaultPanel()): PanelState {
  try {
    const s = storage()
    return s ? parsePanel(s.getItem(PANEL_KEY), d) : d
  } catch {
    return d
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
