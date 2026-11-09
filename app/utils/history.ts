// Pure helpers for the History tab: the revision list's rows and the preview banner.

/** A row of `GET /api/boards/:id/revisions`. */
export interface RevisionRow {
  n: number
  /** ms since the epoch. */
  createdAt: number
  author: string
  how: 'create' | 'import' | 'edit' | 'api' | 'undo' | 'redo' | 'restore' | 'recovered'
  target: number | null
  summary: string
  /** Restored from a bundle: the author is a name only. */
  imported?: boolean
}

/** The badge text for a revision's `how`, with the revision it points at (undo, redo, restore). */
export function howLabel(r: Pick<RevisionRow, 'how' | 'target'>): string {
  return r.target === null ? r.how : `${r.how} of #${r.target}`
}

/** `#42 · Claude · undo of #41`. */
export function revisionLabel(r: RevisionRow): string {
  return `#${r.n} · ${r.author} · ${howLabel(r)}`
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else the date. */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(at).toISOString().slice(0, 10)
}

/** The banner above the canvas while a past revision is on show. */
export function previewBanner(r: Pick<RevisionRow, 'n' | 'author'>): string {
  return `Viewing #${r.n} by ${r.author}. Restore makes it the current board; nothing is lost.`
}

/** Why editing is off while a past revision is on show. */
export const PREVIEW_TITLE = 'Viewing a past revision: go back to the current board to edit'
