import type * as Y from 'yjs'
import { parseBoard, type BoardFile, type ParseResult } from '~core/schema'

type Item = Record<string, unknown>

/** The list sections of a board, and how each item is keyed. */
export const SECTIONS = {
  parts: (p: { ref: string }) => p.ref,
  trails: (t: { id: string }) => t.id,
  wires: (w: { id: string }) => w.id,
  legFolds: (f: { lead: string }) => f.lead,
  solderBridges: (s: { side: string, a: string, b: string }) => `${s.side}:${s.a}:${s.b}`
} as const

/** Name-keyed records. */
export const RECORDS = ['nets', 'netClasses'] as const

/** One-off values. */
export const SINGLES = ['name', 'board', 'rules', 'bench'] as const

export type SectionName = keyof typeof SECTIONS
export const SECTION_NAMES = Object.keys(SECTIONS) as SectionName[]

/** JSON with sorted keys, so equal values compare equal whatever their key order. */
export function stable(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      return Object.fromEntries(Object.keys(o).sort().map(k => [k, sort(o[k])]))
    }
    return x
  }
  return JSON.stringify(sort(v))
}

/** A copy with no `undefined` fields, as JSON would store it. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** The items of a section as [key, item] pairs, in file order. */
export function sectionItems(b: BoardFile, name: SectionName): [string, unknown][] {
  const keyOf = SECTIONS[name] as (i: Item) => string
  return (b[name] as Item[]).map(item => [keyOf(item), item])
}

/** Each item's `stable` JSON by key: section items by id, record entries by name. */
function keyed(entries: [string, unknown][]): Map<string, string> {
  return new Map(entries.map(([k, v]) => [k, stable(v)]))
}

function sameMaps(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/**
 * The same items, whatever their order: sections compared by id, records by key, singles
 * by value. The revision and the order of list sections are ignored (a restore or a
 * re-added item can change the order without changing the board).
 */
export function sameItems(a: BoardFile, b: BoardFile): boolean {
  for (const name of SECTION_NAMES) {
    if (a[name].length !== b[name].length || !sameMaps(keyed(sectionItems(a, name)), keyed(sectionItems(b, name)))) return false
  }
  for (const name of RECORDS) if (!sameMaps(keyed(Object.entries(a[name])), keyed(Object.entries(b[name])))) return false
  return SINGLES.every(name => stable(a[name]) === stable(b[name]))
}

/** The key of one item for `withItems`: `<section>:<id>`, `<record>:<key>` or `singles:<name>`. */
export const itemKey = (root: string, key: string) => `${root}:${key}`

/**
 * `head` with the items named by `keys` taken from `current` (removed where `current` has
 * none). Items new in `current` go at the end, in `current`'s order. The result is not
 * parsed: the caller runs it through parseBoard.
 */
export function withItems(head: BoardFile, current: BoardFile, keys: Iterable<string>): BoardFile {
  const byRoot = new Map<string, Set<string>>()
  for (const k of keys) {
    const at = k.indexOf(':')
    const root = k.slice(0, at)
    if (!byRoot.has(root)) byRoot.set(root, new Set())
    byRoot.get(root)!.add(k.slice(at + 1))
  }
  const out = plain(head) as unknown as Record<string, unknown>
  for (const name of SECTION_NAMES) {
    const touched = byRoot.get(name)
    if (!touched) continue
    const now = new Map(sectionItems(current, name))
    const was = sectionItems(head, name)
    const list = was.flatMap(([k, v]) => !touched.has(k) ? [v] : now.has(k) ? [now.get(k)] : [])
    const known = new Set(was.map(([k]) => k))
    for (const [k, v] of now) if (touched.has(k) && !known.has(k)) list.push(v)
    out[name] = plain(list)
  }
  for (const name of RECORDS) {
    const touched = byRoot.get(name)
    if (!touched) continue
    const now = current[name] as Record<string, unknown>
    const kept = Object.entries(out[name] as Record<string, unknown>).filter(([k]) => !touched.has(k))
    const taken = [...touched].filter(k => Object.hasOwn(now, k)).map(k => [k, plain(now[k])] as const)
    out[name] = Object.fromEntries([...kept, ...taken])
  }
  const singles = byRoot.get('singles')
  for (const name of SINGLES) {
    if (!singles?.has(name)) continue
    out[name] = current[name] === undefined ? undefined : plain(current[name])
  }
  return out as unknown as BoardFile
}

/** Writes everything into a fresh doc. */
export function boardToDoc(doc: Y.Doc, board: BoardFile): void {
  doc.transact(() => {
    for (const name of SECTION_NAMES) {
      const map = doc.getMap(name)
      sectionItems(board, name).forEach(([key, v], pos) => map.set(key, { pos, v: plain(v) }))
    }
    for (const name of RECORDS) {
      const map = doc.getMap(name)
      for (const [key, v] of Object.entries(board[name])) map.set(key, plain(v))
    }
    const singles = doc.getMap('singles')
    for (const name of SINGLES) singles.set(name, plain(board[name]))
  })
}

const isObject = (v: unknown): v is Item => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Why a section entry is not `{ pos, v }` stored under its own id, or null when it is. */
function badEntry(name: SectionName, key: string, e: unknown): string | null {
  if (!isObject(e) || typeof e.pos !== 'number' || !isObject(e.v)) return `${name}: the entry "${key}" is not { pos, v }`
  const id = (SECTIONS[name] as (i: Item) => unknown)(e.v)
  return id === key ? null : `${name}: the entry "${key}" holds the item "${String(id)}"`
}

/** The board rebuilt from the doc and run through parseBoard. Only the known singles are read. */
export function docToBoard(doc: Y.Doc, revision: number): ParseResult {
  const raw: Record<string, unknown> = { format: 'wirebender/1', revision }
  const errors: string[] = []
  for (const name of SECTION_NAMES) {
    const entries = [...doc.getMap<{ pos: number, v: unknown }>(name).entries()]
    for (const [key, e] of entries) {
      const bad = badEntry(name, key, e)
      if (bad) errors.push(bad)
    }
    if (errors.length > 0) continue
    entries.sort(([ka, a], [kb, b]) => a.pos - b.pos || (ka < kb ? -1 : ka > kb ? 1 : 0))
    raw[name] = entries.map(([, e]) => e.v)
  }
  if (errors.length > 0) return { ok: false, errors }
  for (const name of RECORDS) raw[name] = Object.fromEntries(doc.getMap(name).entries())
  const singles = doc.getMap('singles')
  for (const name of SINGLES) if (singles.has(name)) raw[name] = singles.get(name)
  return parseBoard(raw)
}

/** The keys of the singles map that are not one of SINGLES. */
export function unknownSingles(doc: Y.Doc): string[] {
  const known = new Set<string>(SINGLES)
  return [...doc.getMap('singles').keys()].filter(k => !known.has(k))
}

/** One transaction that writes only the items that differ, and deletes the removed ones. */
export function writeBoard(doc: Y.Doc, before: BoardFile, after: BoardFile, origin?: unknown): void {
  doc.transact(() => {
    for (const name of SECTION_NAMES) {
      const map = doc.getMap<{ pos: number, v: unknown }>(name)
      const old = new Map(sectionItems(before, name).map(([k, v]) => [k, stable(v)]))
      let max = -1
      for (const e of map.values()) max = Math.max(max, e.pos)
      const keep = new Set<string>()
      for (const [key, v] of sectionItems(after, name)) {
        keep.add(key)
        const existing = map.get(key)
        if (old.get(key) === stable(v)) continue
        map.set(key, { pos: existing ? existing.pos : ++max, v: plain(v) })
      }
      for (const key of old.keys()) if (!keep.has(key)) map.delete(key)
    }
    for (const name of RECORDS) {
      const map = doc.getMap(name)
      const was = before[name] as Record<string, unknown>
      const now = after[name] as Record<string, unknown>
      for (const [key, v] of Object.entries(now)) {
        if (!(key in was) || stable(was[key]) !== stable(v)) map.set(key, plain(v))
      }
      for (const key of Object.keys(was)) if (!(key in now)) map.delete(key)
    }
    const singles = doc.getMap('singles')
    for (const name of SINGLES) {
      if (stable(before[name]) !== stable(after[name])) singles.set(name, plain(after[name]))
    }
  }, origin)
}
