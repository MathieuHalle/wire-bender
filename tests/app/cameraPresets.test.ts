import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { parseBoard, type BoardFile } from '~core/schema'
import { buildScene, type Scene3D, type V3 } from '~core/scene3d'
import { CAMERA_FOV, cameraPreset } from '../../app/utils/cameraPresets'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const ASPECT = 16 / 9

function camera(scene: Scene3D, which: 'top' | 'bottom' | 'iso', aspect = ASPECT) {
  const p = cameraPreset(scene, which, aspect)
  const cam = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 10000)
  cam.position.set(...p.position)
  cam.up.set(...p.up)
  cam.lookAt(...p.target)
  cam.updateMatrixWorld()
  return cam
}

const project = (cam: THREE.Camera, q: V3) => new THREE.Vector3(...q).project(cam)

describe('cameraPreset', () => {
  const b = board2()
  const scene = buildScene(b)
  const cols = b.board.cols
  // Holes are row-major: A1 is first, A{cols} ends row A, B1 starts row B.
  const a1 = scene.holes[0]!
  const aN = scene.holes[cols - 1]!
  const lastRow = scene.holes[scene.holes.length - 1]!
  const onTop = (h: { x: number, z: number }): V3 => [h.x, 0, h.z]
  const onBottom = (h: { x: number, z: number }): V3 => [h.x, -scene.board.thicknessMm, h.z]

  it('bottom preset matches the mirrored 2D view', () => {
    const cam = camera(scene, 'bottom')
    const pa1 = project(cam, onBottom(a1))
    const paN = project(cam, onBottom(aN))
    const pz = project(cam, onBottom(lastRow))
    expect(pa1.x).toBeGreaterThan(paN.x) // A1 right of A{cols}
    expect(pa1.y).toBeGreaterThan(pz.y) // row A at the top
    expect(paN.y).toBeGreaterThan(pz.y)
  })

  it('top preset', () => {
    const cam = camera(scene, 'top')
    const pa1 = project(cam, onTop(a1))
    const paN = project(cam, onTop(aN))
    const pz = project(cam, onTop(lastRow))
    expect(pa1.x).toBeLessThan(paN.x)
    expect(pa1.y).toBeGreaterThan(pz.y)
  })

  it('iso preset sees the whole board', () => {
    for (const aspect of [ASPECT, 1, 0.5]) {
      const cam = camera(scene, 'iso', aspect)
      const { center: [cx, cy, cz], widthMm: w, depthMm: d } = scene.board
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const p = project(cam, [cx + sx * w / 2, cy, cz + sz * d / 2])
          expect(Math.abs(p.x)).toBeLessThanOrEqual(1)
          expect(Math.abs(p.y)).toBeLessThanOrEqual(1)
          expect(p.z).toBeLessThan(1) // in front of the far plane, not behind the camera
        }
    }
  })

  it('targets the board centre', () => {
    for (const w of ['top', 'bottom', 'iso'] as const)
      expect(cameraPreset(scene, w, ASPECT).target).toEqual(scene.board.center)
  })
})
