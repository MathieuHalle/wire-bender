// The view layers: the group switches of the Layers tab. View only: they never change the board file or the
// check. Holes and pads are not a layer; they always show.
import type { JointOwner, Tag } from '~core/scene3d'
import type { Tool } from './boardView'

export interface Layers {
  /** Part bodies, labels and legs (2D); part prims, legs and their joints (3D). */
  components: boolean
  /** Insulated wires, laid and flying, with their ends. */
  wires: boolean
  /** Bare trails and their joints, leg-folds and solder bridges. */
  trails: boolean
}

export const ALL_LAYERS: Readonly<Layers> = Object.freeze({ components: true, wires: true, trails: true })

function ownerShown(o: JointOwner, layers: Layers): boolean {
  if (o === 'part') return layers.components
  if (o === 'wire') return layers.wires
  return layers.trails // trail, fold
}

/** Whether a 3D prim with this tag is drawn under `layers`. The slab and untagged meshes always are. */
export function visibleTag(tag: Tag | undefined, layers: Layers): boolean {
  if (!tag) return true
  switch (tag.kind) {
    case 'part':
    case 'leg':
      return layers.components
    case 'trail':
    case 'fold':
    case 'bridge':
      return layers.trails
    case 'wire':
      return layers.wires
    case 'joint':
      // One cone can stand for several joints at a spot (a trail end on a part lead): it
      // shows while any of its owners does. A joint without owners is always shown.
      return !tag.owners?.length || tag.owners.some(o => ownerShown(o, layers))
    default:
      return true
  }
}

/** The tools that edit trails and joints. */
const EDITING: readonly Tool[] = ['pencil', 'erase', 'joint']

/** The Edit tab's one-line warning while editing what is not drawn; null otherwise. */
export function blindHint(tool: Tool, layers: Layers): string | null {
  return EDITING.includes(tool) && !layers.trails
    ? 'Trails are hidden: you\'re drawing blind.'
    : null
}
