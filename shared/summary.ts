import type { BoardFile } from '~core/schema'
import { RECORDS, SECTION_NAMES, SINGLES, sectionItems, stable } from './yboard'

const LABEL: Record<string, string> = {
  parts: 'part', trails: 'trail', wires: 'wire', legFolds: 'legFold', solderBridges: 'solderBridge',
  nets: 'net', netClasses: 'netClass'
}
const SHOWN = 3

/** A one-line description of what changed between two boards. */
export function summarize(before: BoardFile | null, after: BoardFile): string {
  if (!before) return 'created'
  const parts: string[] = []
  const diff = (name: string, a: Map<string, unknown>, b: Map<string, unknown>) => {
    const label = LABEL[name]!
    for (const k of b.keys()) if (!a.has(k)) parts.push(`${label} ${k} added`)
    for (const k of a.keys()) if (!b.has(k)) parts.push(`${label} ${k} removed`)
    for (const [k, v] of b) {
      if (!a.has(k) || stable(a.get(k)) === stable(v)) continue
      const side = name === 'solderBridges' ? undefined : (v as { side?: unknown }).side
      parts.push(`${label} ${k} changed${typeof side === 'string' ? ` (${side})` : ''}`)
    }
  }
  for (const name of SECTION_NAMES) {
    diff(name, new Map(sectionItems(before, name)), new Map(sectionItems(after, name)))
  }
  for (const name of RECORDS) diff(name, new Map(Object.entries(before[name])), new Map(Object.entries(after[name])))
  for (const name of SINGLES) if (stable(before[name]) !== stable(after[name])) parts.push(`${name} changed`)
  if (!parts.length) return 'no change'
  const more = parts.length - SHOWN
  return more > 0 ? [...parts.slice(0, SHOWN), `and ${more} more`].join('; ') : parts.join('; ')
}
