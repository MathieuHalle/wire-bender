// What the 2D canvas shares with the board sides drawn in it: the element tooltips are
// placed in (so they stay inside the canvas), and the camera, so a side can hit-test the
// resting pointer again after a zoom or pan moved the board under it.
import type { InjectionKey, Ref } from 'vue'
import type { Camera, Point } from './camera2d'

export interface CanvasContext {
  overlay: Readonly<Ref<HTMLElement | null>>
  camera: Readonly<Ref<Camera>>
  panning: Readonly<Ref<boolean>>
  /** The pointer over the canvas in client px, or null; plain (not reactive). */
  pointer: { readonly value: Point | null }
}

export const CANVAS_CONTEXT: InjectionKey<CanvasContext> = Symbol('wirebender:canvas')
