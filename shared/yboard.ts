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

/** The board rebuilt from the doc and run through parseBoard. */
export function docToBoard(doc: Y.Doc, revision: number): ParseResult {
  const raw: Record<string, unknown> = { format: 'wirebender/1', revision }
  for (const name of SECTION_NAMES) {
    const entries = [...doc.getMap<{ pos: number, v: unknown }>(name).entries()]
    entries.sort(([ka, a], [kb, b]) => a.pos - b.pos || (ka < kb ? -1 : ka > kb ? 1 : 0))
    raw[name] = entries.map(([, e]) => e.v)
  }
  for (const name of RECORDS) raw[name] = Object.fromEntries(doc.getMap(name).entries())
  for (const [k, v] of doc.getMap('singles').entries()) raw[k] = v
  return parseBoard(raw)
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
