export type Hole = { col: number, row: number }

const NAME_RE = /^([A-Z]+)([1-9][0-9]*)$/

/** Row letters: A..Z, then AA, AB, ... (1-based). */
function rowFromLetters(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function rowToLetters(row: number): string {
  let s = ''
  let n = row
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

export function parseHole(name: string): Hole {
  const m = typeof name === 'string' ? NAME_RE.exec(name) : null
  if (!m) throw new Error(`bad hole name: ${name}`)
  return { col: Number(m[2]), row: rowFromLetters(m[1]!) }
}

/** parseHole, or null for a name that is not a hole. */
export function tryParseHole(name: string): Hole | null {
  try {
    return parseHole(name)
  } catch {
    return null
  }
}

export function holeName(h: Hole): string {
  return `${rowToLetters(h.row)}${h.col}`
}

export function holeKey(h: Hole): string {
  return `${h.col},${h.row}`
}

export function holeMm(h: Hole, pitchMm = 2.54): { x: number, y: number } {
  return { x: (h.col - 1) * pitchMm, y: (h.row - 1) * pitchMm }
}

/** Every hole from a to b inclusive; a and b must share a row or a column. */
export function straightRun(a: Hole, b: Hole): Hole[] {
  if (a.col !== b.col && a.row !== b.row) throw new Error('diagonal')
  const dc = Math.sign(b.col - a.col)
  const dr = Math.sign(b.row - a.row)
  const n = Math.max(Math.abs(b.col - a.col), Math.abs(b.row - a.row))
  const out: Hole[] = []
  for (let i = 0; i <= n; i++) out.push({ col: a.col + dc * i, row: a.row + dr * i })
  return out
}

/**
 * Every hole along a polyline in walking order, bend points once, revisits kept. With
 * `segments`, only those stretches (by index of their first point) are walked.
 */
export function walkHoles(points: Hole[], segments?: number[]): Hole[] {
  if (points.length === 1 && !segments) return [points[0]!]
  const out: Hole[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    if (segments && !segments.includes(i)) continue
    const run = straightRun(points[i]!, points[i + 1]!)
    const last = out[out.length - 1]
    out.push(...(last && holeKey(last) === holeKey(run[0]!) ? run.slice(1) : run))
  }
  return out
}

/** Every hole on a polyline (or on its `segments`), bend points included, without repeats. */
export function pathHoles(points: Hole[], segments?: number[]): Hole[] {
  const seen = new Map<string, Hole>()
  for (const h of walkHoles(points, segments)) if (!seen.has(holeKey(h))) seen.set(holeKey(h), h)
  return [...seen.values()]
}
