// Turns the pure `Scene3D` (core/scene3d) into three.js meshes. Only the lazily loaded
// 3D view imports this file, so three.js stays out of the 2D page's bundle.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  COLORS, COPPER_THICKNESS_MM, HOLE_DIAMETER_MM, PAD_DIAMETER_MM,
  type Prim, type Scene3D, type Tag, type V3
} from '~core/scene3d'

const HOLE_COLOR = '#16150f'
const SEGMENTS = 16
/** Lifts the hole discs off the surface so they don't z-fight with the slab. */
const LIFT = 0.003
const METAL_KINDS = new Set<Tag['kind']>(['leg', 'trail', 'joint', 'fold', 'bridge'])
const Y = new THREE.Vector3(0, 1, 0)

export interface BuiltMeshes {
  group: THREE.Group
  dispose(): void
}

/** Disposes every geometry and material under `root`, then empties it. */
export function dispose(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const instanced: THREE.InstancedMesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    geometries.add(m.geometry)
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat)
    if ((m as THREE.InstancedMesh).isInstancedMesh) instanced.push(m as THREE.InstancedMesh)
  })
  for (const g of geometries) g.dispose()
  for (const m of materials) m.dispose()
  for (const i of instanced) i.dispose()
  root.clear()
}

/** A cylinder from a to b, baked into the geometry; null when a and b coincide. */
function segmentGeometry(a: V3, b: V3, radius: number): THREE.BufferGeometry | null {
  const va = new THREE.Vector3(...a)
  const dir = new THREE.Vector3(...b).sub(va)
  const len = dir.length()
  if (len < 1e-9) return null
  const g = new THREE.CylinderGeometry(radius, radius, len, SEGMENTS, 1, true)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, dir.clone().normalize()))
  g.translate(va.x + dir.x / 2, va.y + dir.y / 2, va.z + dir.z / 2)
  return g
}

/** A polyline tube: a cylinder per segment and a ball at each point, so corners stay closed. */
function tubeGeometry(points: V3[], radius: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 1; i < points.length; i++) {
    const g = segmentGeometry(points[i - 1]!, points[i]!, radius)
    if (g) parts.push(g)
  }
  for (const p of points) {
    const s = new THREE.SphereGeometry(radius, SEGMENTS, SEGMENTS / 2)
    s.translate(...p)
    parts.push(s)
  }
  const merged = mergeGeometries(parts) ?? new THREE.BufferGeometry()
  for (const g of parts) g.dispose()
  return merged
}

function primMesh(p: Prim, material: (color: string, kind: Tag['kind']) => THREE.Material): THREE.Mesh {
  let mesh: THREE.Mesh
  switch (p.kind) {
    case 'box': {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), material(p.color, p.tag.kind))
      mesh.position.set(...p.center)
      mesh.rotation.y = p.rotY ?? 0
      break
    }
    case 'cylinder': {
      const a = new THREE.Vector3(...p.a)
      const dir = new THREE.Vector3(...p.b).sub(a)
      const len = Math.max(dir.length(), 1e-6)
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, len, SEGMENTS), material(p.color, p.tag.kind))
      mesh.position.copy(a).addScaledVector(dir, 0.5)
      if (dir.lengthSq() > 0) mesh.quaternion.setFromUnitVectors(Y, dir.normalize())
      break
    }
    case 'tube':
      mesh = new THREE.Mesh(tubeGeometry(p.points, p.radius), material(p.color, p.tag.kind))
      break
    case 'cone': {
      mesh = new THREE.Mesh(new THREE.ConeGeometry(p.radius, p.height, SEGMENTS), material(p.color, p.tag.kind))
      mesh.position.set(p.base[0], p.base[1] + (p.up * p.height) / 2, p.base[2])
      if (p.up < 0) mesh.rotation.x = Math.PI
      break
    }
  }
  mesh.userData.tag = p.tag
  return mesh
}

/** Instance matrices for flat things lying on the top (facing +y) or bottom (facing -y) surface. */
function surfaceMatrices(top: { x: number, z: number }[], bottom: { x: number, z: number }[], topY: number, bottomY: number): THREE.Matrix4[] {
  const flip = new THREE.Matrix4().makeRotationX(Math.PI)
  return [
    ...top.map(h => new THREE.Matrix4().makeTranslation(h.x, topY, h.z)),
    ...bottom.map(h => new THREE.Matrix4().makeTranslation(h.x, bottomY, h.z).multiply(flip))
  ]
}

function instanced(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length)
  mesh.name = name
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
  return mesh
}

/**
 * The scene as meshes: the slab, the holes (dark discs on both surfaces) and pads (thin
 * copper rings) as instanced meshes, then one mesh per prim in `scene.prims` order, each
 * with `userData.tag`. `dispose()` frees every geometry and material made here.
 */
export function buildMeshes(scene: Scene3D): BuiltMeshes {
  const group = new THREE.Group()
  group.name = 'board3d'
  const cache = new Map<string, THREE.MeshStandardMaterial>()
  const material = (color: string, kind: Tag['kind']) => {
    const metal = METAL_KINDS.has(kind)
    const key = `${color}|${metal}`
    let m = cache.get(key)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, metalness: metal ? 0.35 : 0, roughness: metal ? 0.4 : 0.7 })
      cache.set(key, m)
    }
    return m
  }

  const { widthMm, depthMm, thicknessMm, center } = scene.board
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(widthMm, thicknessMm, depthMm),
    new THREE.MeshStandardMaterial({ color: COLORS.board, roughness: 0.85 })
  )
  slab.position.set(...center)
  slab.name = 'board'
  slab.userData.tag = { kind: 'board', id: 'board' } satisfies Tag
  group.add(slab)

  const topY = center[1] + thicknessMm / 2
  const bottomY = center[1] - thicknessMm / 2

  const disc = new THREE.CircleGeometry(HOLE_DIAMETER_MM / 2, SEGMENTS).rotateX(-Math.PI / 2)
  group.add(instanced('holes', disc, new THREE.MeshStandardMaterial({ color: HOLE_COLOR, roughness: 1 }),
    surfaceMatrices(scene.holes, scene.holes, topY + LIFT, bottomY - LIFT)))

  const ring = new THREE.Shape().absarc(0, 0, PAD_DIAMETER_MM / 2, 0, Math.PI * 2, false)
  ring.holes.push(new THREE.Path().absarc(0, 0, HOLE_DIAMETER_MM / 2, 0, Math.PI * 2, true))
  const pad = new THREE.ExtrudeGeometry(ring, { depth: COPPER_THICKNESS_MM, bevelEnabled: false, curveSegments: SEGMENTS })
    .rotateX(-Math.PI / 2)
  group.add(instanced('pads', pad, new THREE.MeshStandardMaterial({ color: COLORS.pad, metalness: 0.45, roughness: 0.35 }),
    surfaceMatrices(scene.pads.top, scene.pads.bottom, topY, bottomY)))

  for (const p of scene.prims) group.add(primMesh(p, material))

  return { group, dispose: () => dispose(group) }
}

/** True when this browser hands out a WebGL context. */
export function webglAvailable(): boolean {
  try {
    if (typeof document === 'undefined' || !document) return false
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}
