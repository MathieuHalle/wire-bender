// Camera presets for the 3D view, in board mm (x right, y up, z = row direction).
// The camera keeps y as its up vector so OrbitControls orbits about y; Top and Bottom sit
// a hair off the pole, toward +z (top) or -z (bottom), so row A is at the top of the
// screen in both and the bottom reads like the mirrored 2D bottom view (A1 on the right).
import type { Scene3D, V3 } from '~core/scene3d'

/** Vertical field of view, degrees. */
export const CAMERA_FOV = 40
export type CameraPresetName = 'top' | 'bottom' | 'iso'

const MARGIN = 1.12
/** Off-pole tilt as a fraction of the distance: invisible, but fixes which way is up. */
const TILT = 1e-3
const ISO_DIR: V3 = [0.5, 0.95, 1]

export function cameraPreset(scene: Scene3D, which: CameraPresetName, aspect: number): { position: V3, target: V3, up: V3 } {
  const target: V3 = [...scene.board.center]
  const [cx, , cz] = target
  const { min, max } = scene.bounds
  const v = (CAMERA_FOV * Math.PI) / 180
  const tanV = Math.tan(v / 2)
  const tanH = tanV * aspect
  const up: V3 = [0, 1, 0]

  if (which === 'iso') {
    const r = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2
    const half = Math.min(Math.atan(tanV), Math.atan(tanH))
    const d = (r / Math.sin(half)) * MARGIN
    const n = Math.hypot(...ISO_DIR)
    return { position: [cx + (ISO_DIR[0] / n) * d, target[1] + (ISO_DIR[1] / n) * d, cz + (ISO_DIR[2] / n) * d], target, up }
  }

  // Seen straight on: x across the screen, z up and down.
  const hx = Math.max(cx - min[0], max[0] - cx)
  const hz = Math.max(cz - min[2], max[2] - cz)
  const d = Math.max(hz / tanV, hx / tanH) * MARGIN
  return which === 'top'
    ? { position: [cx, max[1] + d, cz + d * TILT], target, up }
    : { position: [cx, min[1] - d, cz - d * TILT], target, up }
}
