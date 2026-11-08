// How the 2D bottom view is turned over while it is mirrored: left-right (the default) or
// top-bottom. One choice per viewer, kept in localStorage; every access is guarded, since
// storage can be blocked, full or tampered with. The bench sheet follows it.
import { parseFlip, type Flip } from '~core/sideView'

export const FLIP_KEY = 'wirebender:bottomflip'

/** What the storage functions need from `localStorage`. */
export type FlipStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The stored flip, else `lr`; `storage` is a getter because reading `window.localStorage`
 * itself can throw.
 */
export function loadFlip(storage: () => FlipStorage | null | undefined): Flip {
  try {
    return parseFlip(storage()?.getItem(FLIP_KEY)) ?? 'lr'
  } catch {
    return 'lr'
  }
}

/** Writes the flip; false when storage is missing or refuses it. */
export function saveFlip(flip: Flip, storage: () => FlipStorage | null | undefined): boolean {
  try {
    const s = storage()
    if (!s) return false
    s.setItem(FLIP_KEY, flip)
    return true
  } catch {
    return false
  }
}

/** The bench sheet of board `id`, its bottom overviews drawn with `flip`. */
export function benchUrl(id: string, flip: Flip): string {
  return `/api/boards/${encodeURIComponent(id)}/bench?flip=${flip}`
}
