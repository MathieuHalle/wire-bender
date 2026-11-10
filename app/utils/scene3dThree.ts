// Turns the pure `Scene3D` (core/scene3d) into three.js meshes. Only the lazily loaded
// 3D view imports this file, so three.js stays out of the 2D page's bundle.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { BoardFile } from '~core/schema'
import {
  COLORS, COPPER_THICKNESS_MM, HOLE_DIAMETER_MM, LABEL_TEXT_MM, PAD_DIAMETER_MM, tagNets,
  type Prim, type Scene3D, type Tag, type V3, type XZ
} from '~core/scene3d'

const HOLE_COLOR = '#16150f'
const SEGMENTS = 16
/** Lifts the hole discs off the surface so they don't z-fight with the slab. */
const LIFT = 0.003
const Y = new THREE.Vector3(0, 1, 0)

export interface BuiltMeshes {
  group: THREE.Group
  dispose(): void
}

/** A dimmed mesh's own material, put back when it is lit again. */
const baseOf = new WeakMap<THREE.Mesh, THREE.Material>()
/** The dim variant of a (possibly shared) material, made on first use. */
const dimOf = new WeakMap<THREE.Material, THREE.Material>()
/** Opacity of the meshes outside the highlighted nets. */
export const DIM_OPACITY = 0.25

/** Disposes every geometry, material and texture under `root` (dim variants included), then empties it. */
export function dispose(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const instanced: THREE.InstancedMesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    geometries.add(m.geometry)
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat)
    const base = baseOf.get(m)
    if (base) materials.add(base)
    if ((m as THREE.InstancedMesh).isInstancedMesh) instanced.push(m as THREE.InstancedMesh)
  })
  for (const mat of [...materials]) {
    const dim = dimOf.get(mat)
    if (dim) materials.add(dim)
  }
  // Textures (the label atlas) are not freed with their material.
  const textures = new Set<THREE.Texture>()
  for (const m of materials)
    for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture) textures.add(v as THREE.Texture)
  for (const g of geometries) g.dispose()
  for (const m of materials) m.dispose()
  for (const t of textures) t.dispose()
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

const LATHE_SEGMENTS = 32

/**
 * Vertical walls on an x/z outline from y0 to y1. The shape is drawn in (x, -z) and extruded
 * along +z; turning it -90° about x stands it up (shape y -> -z, extrusion -> +y).
 */
export function extrudeGeometry(outline: XZ[], y0: number, y1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(q => new THREE.Vector2(q.x, -q.z)))
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(y1 - y0, 1e-3), bevelEnabled: false, curveSegments: 1 })
  g.rotateX(-Math.PI / 2)
  g.translate(0, y0, 0)
  return g
}

function primMesh(p: Prim, material: (color: string, metal: boolean) => THREE.Material): THREE.Mesh {
  let mesh: THREE.Mesh
  switch (p.kind) {
    case 'box': {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), material(p.color, !!p.metal))
      mesh.position.set(...p.center)
      mesh.rotation.y = p.rotY ?? 0
      break
    }
    case 'cylinder': {
      const a = new THREE.Vector3(...p.a)
      const dir = new THREE.Vector3(...p.b).sub(a)
      const len = Math.max(dir.length(), 1e-6)
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, len, SEGMENTS), material(p.color, !!p.metal))
      mesh.position.copy(a).addScaledVector(dir, 0.5)
      if (dir.lengthSq() > 0) mesh.quaternion.setFromUnitVectors(Y, dir.normalize())
      break
    }
    case 'tube':
      mesh = new THREE.Mesh(tubeGeometry(p.points, p.radius), material(p.color, !!p.metal))
      break
    case 'cone': {
      mesh = new THREE.Mesh(new THREE.ConeGeometry(p.radius, p.height, SEGMENTS), material(p.color, !!p.metal))
      mesh.position.set(p.base[0], p.base[1] + (p.up * p.height) / 2, p.base[2])
      if (p.up < 0) mesh.rotation.x = Math.PI
      break
    }
    case 'extrude':
      mesh = new THREE.Mesh(extrudeGeometry(p.outline, p.y0, p.y1), material(p.color, !!p.metal))
      break
    case 'lathe': {
      const pts = p.profile.map(q => new THREE.Vector2(Math.max(0, q.r), q.y))
      mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, LATHE_SEGMENTS), material(p.color, !!p.metal))
      mesh.position.set(p.axis.x, 0, p.axis.z)
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
  /** One material per colour and finish; metal comes from the prim (core decides what is bare metal). */
  const material = (color: string, metal: boolean) => {
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

  const labels = labelMesh(scene, newCanvas())
  if (labels) group.add(labels)

  for (const p of scene.prims) group.add(primMesh(p, material))

  return { group, dispose: () => dispose(group) }
}

/** A fresh canvas for the label atlas; null without a DOM (tests, server). */
function newCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || !document) return null
  try {
    return document.createElement('canvas')
  } catch {
    return null
  }
}

/** Atlas font size, px; a cell is LABEL_CELL px tall. */
const LABEL_PX = 48
const LABEL_CELL = 64
const LABEL_ATLAS_W = 1024
/** Same family as the 2D view's numbers. */
const LABEL_FONT = `600 ${LABEL_PX}px 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace`
/** A column number is shrunk to fit this share of a pitch, so neighbours never touch. */
const LABEL_FIT = 0.9

/**
 * The printed column numbers and row letters (`scene.labels`) as one mesh: a quad per label,
 * flat on the top surface and a hair above it, all cut from one canvas atlas that holds each
 * text once. The atlas is an alpha map tinted COLORS.print, so it shades like ink on the
 * slab. Text reads along +x with its top toward -z (row A), upright in the top and iso views.
 * Null when there is no canvas or no labels. Free it with `dispose`.
 */
export function labelMesh(scene: Scene3D, canvas: HTMLCanvasElement | null): THREE.Mesh | null {
  if (!canvas || !scene.labels.length) return null
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Lay the distinct texts out in rows of cells.
  ctx.font = LABEL_FONT
  const texts = [...new Set(scene.labels.map(l => l.text))]
  const cells = new Map<string, { x: number, y: number, w: number }>()
  let x = 0
  let y = 0
  for (const t of texts) {
    const w = Math.ceil(ctx.measureText(t).width) + 8
    if (x + w > LABEL_ATLAS_W) {
      x = 0
      y += LABEL_CELL
    }
    cells.set(t, { x, y, w })
    x += w
  }
  canvas.width = LABEL_ATLAS_W
  canvas.height = y + LABEL_CELL
  // Setting the size resets the context. White on black: the alpha map reads the green channel.
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.font = LABEL_FONT
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const [t, c] of cells) ctx.fillText(t, c.x + c.w / 2, c.y + LABEL_CELL / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 8 // the renderer clamps it; keeps the numbers sharp at a slant

  const { center, thicknessMm } = scene.board
  // The pitch, from the first two holes (neighbours in a row, or in a column on a one-column board).
  const pitch = scene.holes.length > 1 ? Math.hypot(scene.holes[1]!.x - scene.holes[0]!.x, scene.holes[1]!.z - scene.holes[0]!.z) : Infinity
  const mmPerPx = LABEL_TEXT_MM / LABEL_PX
  const ly = center[1] + thicknessMm / 2 + LIFT
  const W = canvas.width
  const H = canvas.height
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const index: number[] = []
  scene.labels.forEach((l, i) => {
    const c = cells.get(l.text)!
    let w = c.w * mmPerPx
    let h = LABEL_CELL * mmPerPx
    const along = l.edge === 'top' || l.edge === 'bottom'
    if (along && w > pitch * LABEL_FIT) {
      const k = (pitch * LABEL_FIT) / w
      w *= k
      h *= k
    }
    const [x0, x1, z0, z1] = [l.x - w / 2, l.x + w / 2, l.z - h / 2, l.z + h / 2]
    const [u0, u1] = [c.x / W, (c.x + c.w) / W]
    // Canvas row 0 is the top of the texture (v = 1, flipY).
    const [v0, v1] = [1 - c.y / H, 1 - (c.y + LABEL_CELL) / H]
    // Top-left, bottom-left, bottom-right, top-right; "top" is toward -z.
    positions.push(x0, ly, z0, x0, ly, z1, x1, ly, z1, x1, ly, z0)
    uvs.push(u0, v0, u0, v1, u1, v1, u1, v0)
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0)
    const b = i * 4
    index.push(b, b + 1, b + 2, b, b + 2, b + 3) // counter-clockwise seen from above
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(index)
  const material = new THREE.MeshStandardMaterial({
    color: COLORS.print, alphaMap: texture, transparent: true, depthWrite: false, roughness: 0.85,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'labels'
  return mesh
}

/** The prim meshes of a build (every tagged mesh but the slab), in `scene.prims` order. */
export function primMeshes(group: THREE.Object3D): THREE.Mesh[] {
  return group.children.filter((o): o is THREE.Mesh =>
    (o as THREE.Mesh).isMesh && !!o.userData.tag && (o.userData.tag as Tag).kind !== 'board')
}

/**
 * Lights the meshes whose tag nets (`tagNets`) meet `nets` and dims the rest (transparent,
 * opacity 0.25). A shorted group's meshes carry all its nets, so they light up as one. Materials are shared between meshes, so a dimmed mesh is given a dim variant of
 * its material instead of changing the shared one. An empty `nets` puts every mesh's own
 * material back.
 */
export function setHighlight(meshes: THREE.Mesh[], nets: string[]): void {
  const lit = new Set(nets)
  for (const m of meshes) {
    const base = baseOf.get(m) ?? (m.material as THREE.Material)
    if (!lit.size || tagNets(m.userData.tag as Tag | undefined).some(n => lit.has(n))) {
      m.material = base
      baseOf.delete(m)
      continue
    }
    let dim = dimOf.get(base)
    if (!dim) {
      dim = base.clone()
      dim.transparent = true
      dim.opacity = DIM_OPACITY
      dimOf.set(base, dim)
    }
    baseOf.set(m, base)
    m.material = dim
  }
}

/** The finding marks' colour, the same as in 2D. */
export const MARK_COLOR = '#e11d48'
/** The 2D mark: a ring of radius 1.5 mm, 0.4 mm wide, dashes 0.8 and gaps 0.4. */
const MARK_R = 1.5
const MARK_W = 0.4
const MARK_DASHES = 8
/** Above the 0.05 mm copper. */
const MARK_LIFT = 0.06
/** Drawn after everything else: the rings are not depth-tested, so they show over the parts. */
const MARK_RENDER_ORDER = 10

/**
 * Red dashed rings at `at` (hole centres in scene x/z): one instanced mesh on the top
 * surface (`marks-top`) and one on the bottom (`marks-bottom`), in a group. They are drawn
 * over everything, like the 2D marks; `markVisibility` shows only the side the camera is
 * on, so they never show through the board. Empty `at` gives an empty group. Free with
 * `dispose`.
 */
export function markRings(scene: Scene3D, at: XZ[]): THREE.Group {
  const group = new THREE.Group()
  group.name = 'marks'
  if (!at.length) return group
  const step = (Math.PI * 2) / MARK_DASHES
  const arcs = Array.from({ length: MARK_DASHES }, (_, i) =>
    new THREE.RingGeometry(MARK_R - MARK_W / 2, MARK_R + MARK_W / 2, 6, 1, i * step, step * (2 / 3)))
  const geometry = (mergeGeometries(arcs) ?? new THREE.BufferGeometry()).rotateX(-Math.PI / 2)
  for (const g of arcs) g.dispose()
  const material = new THREE.MeshBasicMaterial({ color: MARK_COLOR, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  const { center, thicknessMm } = scene.board
  const top = instanced('marks-top', geometry, material, surfaceMatrices(at, [], center[1] + thicknessMm / 2 + MARK_LIFT, 0))
  const bottom = instanced('marks-bottom', geometry, material, surfaceMatrices([], at, 0, center[1] - thicknessMm / 2 - MARK_LIFT))
  top.renderOrder = bottom.renderOrder = MARK_RENDER_ORDER
  group.add(top, bottom)
  return group
}

/** Shows the top rings while the camera is above the board and the bottom ones while it is below. */
export function markVisibility(marks: THREE.Object3D, scene: Scene3D, camera: THREE.Camera): void {
  const { center, thicknessMm } = scene.board
  const y = camera.getWorldPosition(new THREE.Vector3()).y
  const top = marks.getObjectByName('marks-top')
  const bottom = marks.getObjectByName('marks-bottom')
  if (top) top.visible = y > center[1] + thicknessMm / 2
  if (bottom) bottom.visible = y < center[1] - thicknessMm / 2
}

export interface TagTip {
  /** First line, bold: the part ref, `ref pin N`, or what the conductor is. */
  name: string
  lines: string[]
  /** The net line; null for part bodies. */
  net: string | null
}

/** What the 3D tooltip shows for a hovered mesh; null for the slab. */
export function tagTip(tag: Tag, board: BoardFile): TagTip | null {
  if (tag.kind === 'board') return null
  if (tag.kind === 'part') {
    const part = board.parts.find(p => p.ref === tag.id)
    const label = tag.label && tag.label !== tag.id ? tag.label : undefined
    const extra = part?.value ?? label
    return { name: tag.id, lines: extra ? [extra] : [], net: null }
  }
  const nets = tagNets(tag)
  const net = nets.length > 1 ? `short: ${nets.join(' + ')}` : nets[0] ?? 'no net'
  return { name: tag.label ?? tag.id, lines: [], net }
}

/** The probe's answer, once asked: every mount of the 3D view reuses it. */
let webgl: boolean | undefined

/**
 * True when this browser hands out a WebGL context. Probed once per page load; the probe's
 * context is released at once, so remounting the 3D view does not use up contexts.
 */
export function webglAvailable(): boolean {
  if (webgl !== undefined) return webgl
  if (typeof document === 'undefined' || !document) return false
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
    webgl = !!gl
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      // Releasing early is a courtesy; the answer stands.
    }
  } catch {
    webgl = false
  }
  return webgl
}

/** Forgets the probe's answer (tests). */
export function resetWebglProbe(): void {
  webgl = undefined
}
