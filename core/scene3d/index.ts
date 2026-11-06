import { FOOTPRINTS, placePart } from '../footprints'
import type { BoardFile } from '../schema'
import { boardGeometry } from './board'
import { conductorPrims, leadNets, sceneConnectivity } from './conductors'
import { partPrims } from './parts'
import type { Prim, Scene3D, V3 } from './types'

export * from './types'
export * from './dims'
export * from './tags'

/** Keep the first solder cone per (hole, side); every cone in the scene goes through here. */
export function dedupCones(prims: Prim[]): Prim[] {
  const seen = new Set<string>()
  return prims.filter((p) => {
    if (p.kind !== 'cone') return true
    const key = `${p.base[0].toFixed(3)},${p.base[2].toFixed(3)},${p.up}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sceneBounds(slab: Scene3D['board'], prims: Prim[]): Scene3D['bounds'] {
  const [cx, cy, cz] = slab.center
  const min: V3 = [cx - slab.widthMm / 2, cy - slab.thicknessMm / 2, cz - slab.depthMm / 2]
  const max: V3 = [cx + slab.widthMm / 2, cy + slab.thicknessMm / 2, cz + slab.depthMm / 2]
  const add = (q: V3, rx: number, ry = rx, rz = rx) => {
    const r = [rx, ry, rz]
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, q[i]! - r[i]!)
      max[i] = Math.max(max[i]!, q[i]! + r[i]!)
    }
  }
  for (const p of prims) {
    switch (p.kind) {
      case 'box': {
        const [sx, sy, sz] = p.size
        if (p.rotY) {
          const rr = Math.hypot(sx, sz) / 2
          add(p.center, rr, sy / 2, rr)
        } else add(p.center, sx / 2, sy / 2, sz / 2)
        break
      }
      case 'cylinder':
        add(p.a, p.radius)
        add(p.b, p.radius)
        break
      case 'tube':
        for (const q of p.points) add(q, p.radius)
        break
      case 'cone':
        add(p.base, p.radius, 0, p.radius)
        add([p.base[0], p.base[1] + p.up * p.height, p.base[2]], 0)
        break
    }
  }
  return { min, max }
}

/** The pure 3D scene of a board, in board mm (x right, y up, z = row direction). */
export function buildScene(board: BoardFile): Scene3D {
  const geo = boardGeometry(board)
  const skipped: string[] = []
  let prims: Prim[] = []
  const conn = sceneConnectivity(board)
  // A folded lead's fold tube replaces its cut stub under the board.
  const folded = new Set(board.legFolds.map(f => f.lead))
  for (const part of board.parts) {
    let placed
    try {
      placed = placePart(part)
    } catch (e) {
      skipped.push(Object.hasOwn(FOOTPRINTS, part.footprint)
        ? `part ${part.ref}: ${e instanceof Error ? e.message : String(e)}`
        : `part ${part.ref}: unknown footprint ${part.footprint}`)
      continue
    }
    prims.push(...partPrims(placed, lead => leadNets(conn, lead), folded))
  }
  // After the parts, so a leg's own joint keeps its cone.
  prims.push(...conductorPrims(board, skipped, conn))
  prims = dedupCones(prims)
  return { ...geo, prims, bounds: sceneBounds(geo.board, prims), skipped }
}
