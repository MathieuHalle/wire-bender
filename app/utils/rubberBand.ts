import type { Hole } from '~core/holes'

/**
 * Where the pencil's rubber band ends: from the last drawn point `from`, along its row or column
 * (whichever the pointer (fc, fr) is further along), up to the hole the pointer rounds to. It
 * stops at the last hole the board has (`exists`) on the way, so it never previews into a cut
 * corner or past the edge, where the click would be refused.
 */
export function bandEnd(from: Hole, fc: number, fr: number, exists: (h: Hole) => boolean): Hole {
  const alongRow = Math.abs(fc - from.col) >= Math.abs(fr - from.row)
  const target = Math.round(alongRow ? fc : fr)
  const start = alongRow ? from.col : from.row
  const step = Math.sign(target - start)
  let end = from
  for (let v = start + step; step !== 0 && v !== target + step; v += step) {
    const h = alongRow ? { col: v, row: from.row } : { col: from.col, row: v }
    if (!exists(h)) break
    end = h
  }
  return end
}
