import { benchHtml, tickKey } from '../../export/benchHtml'
import { readBoard } from './boardFile'

export interface BenchResponse {
  status: 200 | 422
  contentType: string
  body: string
  /** Only on 200: the sanitized `<name>.bench.html` for Content-Disposition. */
  filename?: string
}

/** `<name>.bench.html` with only ASCII letters, digits and `-_.` (others become `-`), safe in a header. */
export function benchFilename(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]/g, '-') || 'board'}.bench.html`
}

/** The bench sheet for the board file at `file`, or its parse errors as plain text. */
export async function benchResponse(file: string, date?: string): Promise<BenchResponse> {
  const r = await readBoard(file)
  if (!r.ok) {
    return { status: 422, contentType: 'text/plain; charset=utf-8', body: `${r.errors.join('\n')}\n` }
  }
  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: benchHtml(r.board, { hash: tickKey(r.hash), date }),
    filename: benchFilename(r.board.name)
  }
}
