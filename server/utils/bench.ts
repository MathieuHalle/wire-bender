import { benchHtml } from '../../export/benchHtml'
import type { BoardFile } from '~core/schema'

export interface BenchResponse {
  status: 200
  contentType: string
  body: string
  /** The sanitized `<name>.bench.html` for Content-Disposition. */
  filename: string
  /** Every response header to set, content type included. */
  headers: Record<string, string>
}

/** The name with only ASCII letters, digits and `-_.` (others become `-`), safe in a header. */
export function fileStem(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '-') || 'board'
}

/** `<name>.bench.html`, safe in a header. */
export function benchFilename(name: string): string {
  return `${fileStem(name)}.bench.html`
}

/** The bench sheet for `board`; `hash` keys the phone ticks so they reset when the board changes. */
export function benchResponse(board: BoardFile, hash: string, date?: string): BenchResponse {
  const contentType = 'text/html; charset=utf-8'
  const filename = benchFilename(board.name)
  return {
    status: 200,
    contentType,
    body: benchHtml(board, { hash, date }),
    filename,
    headers: {
      'content-type': contentType,
      // The sheet follows the board: never serve a stale copy.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${filename}"`
    }
  }
}
