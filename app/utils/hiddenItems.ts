// Single items hidden from view: parts, wires and trails, one viewer's choice in this
// browser, kept per board in localStorage. A viewing aid only: the board, its revisions,
// the check and the printouts never see it. The views draw `drawnBoard` (2D and 3D alike,
// from the same set), the board itself is never changed.
//
// An item is shown while its layer is on and its key is not in `hidden`. Keys are
// `<kind>:<id>` (`part:U1`, `wire:W3`, `trail:T7`): part refs and conductor ids are
// unique per kind, not across kinds.
import { holeKey, parseHole, pathHoles, walkHoles, type Hole } from '~core/holes'
import { placePart, type PlacedPart } from '~core/footprints'
import type { BoardFile, Side } from '~core/schema'
import type { Connectivity } from '~core/connectivity'
import type { Lit } from './boardView'
import type { Layers } from './layers'

export type ItemKind = 'part' | 'wire' | 'trail'
export const ITEM_KINDS: readonly ItemKind[] = ['part', 'wire', 'trail']

/** The layer each kind of item belongs to. */
export const LAYER_OF: Record<ItemKind, keyof Layers> = { part: 'components', wire: 'wires', trail: 'trails' }

export interface BoardItem {
  key: string
  kind: ItemKind
  id: string
  /** How the app names it: `R1 10k` (ref and value, else the part's label), `W3`, `T7`. */
  label: string
  /** The side, and `flying` for a flying wire; empty for parts. */
  detail: string
  /** The holes it covers: a part's pins, a trail's or a laid wire's run, a flying wire's ends. */
  holes: Hole[]
}

export type BoardItems = Record<ItemKind, BoardItem[]>

/** What the hiding acts on: the view layers (the panel's state) and the hidden keys (this board's). */
export interface ViewState {
  layers: Layers
  hidden: string[]
}

export const itemKey = (kind: ItemKind, id: string): string => `${kind}:${id}`

function holesOf(points: string[], laid: boolean): Hole[] {
  try {
    const hs = points.map(parseHole)
    return laid ? pathHoles(hs) : hs
  } catch {
    return []
  }
}

function pinHoles(part: BoardFile['parts'][number]): Hole[] {
  try {
    return placePart(part).pins.map(p => p.hole)
  } catch {
    return [] // unknown footprint: listed, nothing to ring
  }
}

/** `R1 10k`: the ref and value; else its label, led by the ref. */
function partLabel(p: BoardFile['parts'][number]): string {
  if (p.value) return `${p.ref} ${p.value}`
  if (!p.label || p.label === p.ref) return p.ref
  return p.label.startsWith(`${p.ref} `) ? p.label : `${p.ref} ${p.label}`
}

/** Every part, wire and trail of the board, in board order. */
export function boardItems(board: BoardFile): BoardItems {
  return {
    part: board.parts.map(p => ({
      key: itemKey('part', p.ref),
      kind: 'part',
      id: p.ref,
      label: partLabel(p),
      detail: '',
      holes: pinHoles(p)
    })),
    wire: board.wires.map(w => ({
      key: itemKey('wire', w.id),
      kind: 'wire',
      id: w.id,
      label: w.id,
      detail: w.kind === 'flying' ? `${w.side}, flying` : w.side,
      holes: holesOf(w.points, w.kind === 'laid')
    })),
    trail: board.trails.map(t => ({
      key: itemKey('trail', t.id),
      kind: 'trail',
      id: t.id,
      label: t.id,
      detail: t.side,
      holes: holesOf(t.points, true)
    }))
  }
}

const allItems = (items: BoardItems): BoardItem[] => ITEM_KINDS.flatMap(k => items[k])

/** The items whose name or side holds every word of `query`, ignoring case. */
export function matchItems(items: BoardItem[], query: string): BoardItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return items
  return items.filter((i) => {
    const text = `${i.label} ${i.detail}`.toLowerCase()
    return words.every(w => text.includes(w))
  })
}

/** Whether an item is drawn. */
export function isShown(item: Pick<BoardItem, 'key' | 'kind'>, s: ViewState, hidden: ReadonlySet<string> = new Set(s.hidden)): boolean {
  return s.layers[LAYER_OF[item.kind]] && !hidden.has(item.key)
}

export type GroupState = 'shown' | 'hidden' | 'mixed'

/** A group's tri-state: every item shown, none shown (or the layer off), or some. */
export function groupState(kind: ItemKind, items: BoardItem[], s: ViewState): GroupState {
  if (!s.layers[LAYER_OF[kind]]) return 'hidden'
  const hidden = new Set(s.hidden)
  const n = items.filter(i => hidden.has(i.key)).length
  return n === 0 ? 'shown' : n === items.length ? 'hidden' : 'mixed'
}

/** The group's toggle: a shown group hides as a whole (its layer off); a mixed or hidden one shows every item. */
export function toggleGroup(kind: ItemKind, items: BoardItem[], s: ViewState): ViewState {
  const layer = LAYER_OF[kind]
  if (groupState(kind, items, s) === 'shown') return { layers: { ...s.layers, [layer]: false }, hidden: [...s.hidden] }
  const mine = new Set(items.map(i => i.key))
  return { layers: { ...s.layers, [layer]: true }, hidden: s.hidden.filter(k => !mine.has(k)) }
}

/**
 * Shows or hides single items. Showing an item whose layer is off turns the layer on and
 * hides the rest of that group one by one, so nothing else appears with it.
 */
export function setShown(keys: string[], shown: boolean, items: BoardItems, s: ViewState): ViewState {
  if (!shown) return { layers: { ...s.layers }, hidden: [...new Set([...s.hidden, ...keys])] }
  const want = new Set(keys)
  const layers = { ...s.layers }
  const hidden = new Set(s.hidden)
  for (const kind of ITEM_KINDS) {
    const layer = LAYER_OF[kind]
    if (layers[layer] || !items[kind].some(i => want.has(i.key))) continue
    layers[layer] = true
    for (const i of items[kind]) hidden.add(i.key)
  }
  for (const k of want) hidden.delete(k)
  return { layers, hidden: [...hidden] }
}

/** "Show all": every layer on, nothing hidden. */
export function showAll(s: ViewState): ViewState {
  return { layers: Object.fromEntries(Object.keys(s.layers).map(k => [k, true])) as unknown as Layers, hidden: [] }
}

/** How many items are not drawn, by layer or one by one. */
export function hiddenCount(items: BoardItems, s: ViewState): number {
  const hidden = new Set(s.hidden)
  return allItems(items).filter(i => !isShown(i, s, hidden)).length
}

/** The hidden keys the board still has items for; the same array when none is stale. */
export function pruneHidden(hidden: string[], board: BoardFile): string[] {
  const keys = new Set(allItems(boardItems(board)).map(i => i.key))
  const kept = hidden.filter(k => keys.has(k))
  return kept.length === hidden.length ? hidden : kept
}

const leadRef = (lead: string) => lead.slice(0, lead.lastIndexOf('.'))

/**
 * The board as the views draw it: a copy without the hidden parts (and their leg-folds),
 * wires and trails. The board itself when nothing it has is hidden.
 */
export function drawnBoard(board: BoardFile, hidden: ReadonlySet<string>): BoardFile {
  if (!hidden.size) return board
  const parts = board.parts.filter(p => !hidden.has(itemKey('part', p.ref)))
  const wires = board.wires.filter(w => !hidden.has(itemKey('wire', w.id)))
  const trails = board.trails.filter(t => !hidden.has(itemKey('trail', t.id)))
  if (parts.length === board.parts.length && wires.length === board.wires.length && trails.length === board.trails.length) return board
  const legFolds = parts.length === board.parts.length
    ? board.legFolds
    : board.legFolds.filter(f => !hidden.has(itemKey('part', leadRef(f.lead))))
  return { ...board, parts, wires, trails, legFolds }
}

/** The placed parts the 2D view draws; the list itself when none is hidden. */
export function drawnPlaced(placed: PlacedPart[], hidden: ReadonlySet<string>): PlacedPart[] {
  if (!hidden.size) return placed
  const out = placed.filter(p => !hidden.has(itemKey('part', p.part.ref)))
  return out.length === placed.length ? placed : out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The items a finding points at: those on its holes, and those its message names. */
export function itemsAtFinding(board: BoardFile, f: { holes: string[], message: string }): string[] {
  const at = new Set<string>()
  for (const n of f.holes) {
    try {
      at.add(holeKey(parseHole(n)))
    } catch {
      // a name that doesn't parse points at nothing
    }
  }
  return allItems(boardItems(board))
    .filter(i => i.holes.some(h => at.has(holeKey(h)))
      || new RegExp(`(^|[^\\w.])${escapeRe(i.id)}(?![\\w])`).test(f.message))
    .map(i => i.key)
}

/** What the panel's hover lights on the 2D board: the item alone (a part with its leads); null for an unknown key. */
export function itemLit(board: BoardFile, key: string): Lit | null {
  const items = boardItems(board)
  const item = allItems(items).find(i => i.key === key)
  if (!item) return null
  const ids = new Set<string>([key])
  if (item.kind === 'part') {
    const part = board.parts.find(p => p.ref === item.id)!
    for (const pin of Object.keys(part.pins)) ids.add(`lead:${part.ref}.${pin}`)
  }
  return { ids, pads: new Set() }
}

/** What the panel's hover lights in 3D: the nets of the item's groups (a part: of its leads). */
export function itemNets(conn: Connectivity, key: string): string[] {
  const at = key.indexOf(':')
  const kind = key.slice(0, at)
  const id = key.slice(at + 1)
  const groups = new Set<number>()
  if (kind === 'part') {
    for (const [lead, gi] of conn.groupOfLead) if (leadRef(lead) === id) groups.add(gi)
  } else if (kind === 'trail' || kind === 'wire') {
    conn.groups.forEach((g, gi) => {
      if (g.conductors.some(c => c.kind === kind && c.id === id)) groups.add(gi)
    })
  }
  return [...new Set([...groups].flatMap(gi => conn.groups[gi]?.nets ?? []))].sort()
}

/**
 * The hidden trail an edit tool would change, or null: the segment a-b for Erase (the
 * first trail on the side over it, as `eraseSegment` picks), the hole a for Joint (the
 * trails passing it, when every one is hidden). Edits on hidden items are refused.
 */
export function editTarget(board: BoardFile, hidden: ReadonlySet<string>, side: Side, a: Hole, b?: Hole): string | null {
  const ka = holeKey(a)
  const trails = board.trails.filter(t => t.side === side)
  const path = (t: BoardFile['trails'][number]) => {
    try {
      return walkHoles(t.points.map(parseHole))
    } catch {
      return []
    }
  }
  const off = (id: string) => hidden.has(itemKey('trail', id))
  if (b) {
    const kb = holeKey(b)
    const t = trails.find((t) => {
      const p = path(t).map(holeKey)
      return p.some((x, i) => i + 1 < p.length && ((x === ka && p[i + 1] === kb) || (x === kb && p[i + 1] === ka)))
    })
    return t && off(t.id) ? t.id : null
  }
  const passing = trails.filter(t => path(t).some(h => holeKey(h) === ka))
  return passing.length && passing.every(t => off(t.id)) ? passing[0]!.id : null
}

// ---- Storage --------------------------------------------------------------------

export const HIDDEN_PREFIX = 'wirebender:hidden:'
export const hiddenKey = (board: string): string => `${HIDDEN_PREFIX}${board}`

/** What the storage functions need from `localStorage`. */
export type HiddenStorage = Pick<Storage, 'getItem' | 'setItem'>

/** The stored `{ hidden: string[] }`; anything else means nothing hidden. */
export function parseHidden(raw: string | null | undefined): string[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  const list = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as { hidden?: unknown }).hidden : undefined
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((k): k is string => typeof k === 'string' && k !== ''))]
}

/**
 * The hidden keys stored for `board`, else none; `storage` is a getter because reading
 * `window.localStorage` itself can throw.
 */
export function loadHidden(board: string, storage: () => HiddenStorage | null | undefined): string[] {
  try {
    return parseHidden(storage()?.getItem(hiddenKey(board)))
  } catch {
    return []
  }
}

/** Writes the hidden keys of `board`; false when storage is missing or refuses it. */
export function saveHidden(board: string, hidden: string[], storage: () => HiddenStorage | null | undefined): boolean {
  try {
    const s = storage()
    if (!s) return false
    s.setItem(hiddenKey(board), JSON.stringify({ hidden }))
    return true
  } catch {
    return false
  }
}
