import { FOOTPRINTS, placePart } from '../footprints'
import type { BoardFile } from '../schema'
import { boardGeometry } from './board'
import { conductorPrims, leadNets, sceneConnectivity } from './conductors'
import { partPrims } from './parts'
import type { Prim, Scene3D, V3 } from './types'

export * from './types'
export * from './dims'
export * from './tags'

/** Keep the first solder cone per (hole, side), with the owners of the ones it replaces; every cone in the scene goes through here. */
export function dedupCones(prims: Prim[]): Prim[] {
  /** Spot -> index in `out` of the cone kept there. */
  const seen = new Map<string, number>()
  const out: Prim[] = []
  for (const p of prims) {
    if (p.kind !== 'cone') {
      out.push(p)
      continue
    }
    const key = `${p.base[0].toFixed(3)},${p.base[2].toFixed(3)},${p.up}`
    const at = seen.get(key)
    if (at === undefined) {
      seen.set(key, out.length)
      out.push(p)
      continue
    }
    // One cone per spot; it keeps the owners of every joint it stands for (the view layers
    // show it while any of them is shown). A copy: the input prims are left as they are.
    const first = out[at]!
    const more = (p.tag.owners ?? []).filter(o => !first.tag.owners?.includes(o))
    if (first.tag.owners && more.length) out[at] = { ...first, tag: { ...first.tag, owners: [...first.tag.owners, ...more] } }
  }
  return out
}

export function sceneBounds(slab: Scene3D['board'], prims: Prim[]): Scene3D['bounds'] {
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
      case 'extrude':
        for (const q of p.outline) {
          add([q.x, p.y0, q.z], 0)
          add([q.x, p.y1, q.z], 0)
        }
        break
      case 'lathe':
        for (const q of p.profile) add([p.axis.x, q.y, p.axis.z], q.r, 0, q.r)
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
