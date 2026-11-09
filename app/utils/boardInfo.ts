// The Board tab's facts: read from the revision list (newest first) and the live board.
import type { BoardFile } from '~core'
import type { RevisionRow } from '~/utils/history'

export interface BoardFacts {
  /** When revision 1 was made: the board's creation. */
  createdAt: number
  last: { n: number, at: number, author: string }
  revisions: number
}

/** Null until the list has loaded. */
export function boardFacts(rows: RevisionRow[]): BoardFacts | null {
  const newest = rows[0]
  const oldest = rows[rows.length - 1]
  if (!newest || !oldest) return null
  return { createdAt: oldest.createdAt, last: { n: newest.n, at: newest.createdAt, author: newest.author }, revisions: rows.length }
}

/** The board's size as the server measures it: compact JSON, in UTF-8 bytes. */
export function boardBytes(board: BoardFile): number {
  return new TextEncoder().encode(JSON.stringify(board)).length
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`
  return `${(n / 1_000_000).toFixed(1)} MB`
}
