export type V3 = [number, number, number]

export interface Tag {
  kind: 'board' | 'part' | 'leg' | 'trail' | 'wire' | 'joint' | 'fold' | 'bridge'
  /** A part ref, `<ref>.<pin>` for legs and their joints, or a trail or wire id. */
  id: string
  /** The net of this conductor or leg; null for NC. Omitted for part bodies. */
  net?: string | null
  /**
   * The sorted nets of the connectivity group this conductor or leg is in. More than one
   * is a short; empty is no net. Omitted for part bodies, and where the group is unknown.
   */
  nets?: string[]
  label?: string
  /**
   * Joints only: what the solder joint belongs to. A part lead's joint and a leg-fold's
   * joints both carry the lead id (`<ref>.<pin>`), so the id alone cannot tell them apart.
   * One cone is drawn per spot (see `dedupCones`); when several conductors are soldered
   * there, it lists each owner, the drawn one (whose id and label the tag has) first.
   */
  owners?: JointOwner[]
}

export type JointOwner = 'part' | 'trail' | 'wire' | 'fold'

/** What every prim has: its colour, its tag, and whether it is bare metal. */
interface PrimLook {
  color: string
  tag: Tag
  /** Bare metal (copper, solder, legs, gold posts, the TO-220 tab): drawn shiny. */
  metal?: boolean
}

export type Prim
  /** size = [x, y, z] extents; rotY in radians about the centre. */
  = | ({ kind: 'box', center: V3, size: V3, rotY?: number } & PrimLook)
  /** Axis a -> b. */
    | ({ kind: 'cylinder', a: V3, b: V3, radius: number } & PrimLook)
  /** Polyline, sharp corners allowed. */
    | ({ kind: 'tube', points: V3[], radius: number } & PrimLook)
  /** Solder: base disc at `base`, apex `height` along y * up. */
    | ({ kind: 'cone', base: V3, up: 1 | -1, radius: number, height: number } & PrimLook)

export interface XZ { x: number, z: number }

export interface Scene3D {
  board: { widthMm: number, depthMm: number, thicknessMm: number, center: V3 }
  holes: XZ[]
  pads: { top: XZ[], bottom: XZ[] }
  prims: Prim[]
  bounds: { min: V3, max: V3 }
  /** Human-readable, e.g. "part X1: unknown footprint foo". */
  skipped: string[]
}
