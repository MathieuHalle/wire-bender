import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { parseBoard, type BoardFile } from '~core/schema'
import { BOARD_THICKNESS_MM, buildScene, type Tag } from '~core/scene3d'
import { buildMeshes, dispose, markRings, MARK_COLOR, primMeshes, setHighlight, tagTip, webglAvailable } from '../../app/utils/scene3dThree'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

function collect(group: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    geometries.add(m.geometry)
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat)
  })
  return { geometries, materials }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('buildMeshes', () => {
  const scene = buildScene(board2())

  it('buildMeshes makes one mesh per prim plus the instanced holes and pads', () => {
    const { group } = buildMeshes(scene)
    const meshes = group.children as THREE.Mesh[]
    const inst = meshes.filter(m => (m as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[]
    const holes = inst.find(m => m.name === 'holes')!
    const pads = inst.find(m => m.name === 'pads')!
    expect(holes.count).toBe(scene.holes.length * 2) // a dark disc on each surface
    expect(pads.count).toBe(scene.pads.top.length + scene.pads.bottom.length)
    const prims = meshes.filter(m => !(m as THREE.InstancedMesh).isInstancedMesh && m.name !== 'board')
    expect(prims).toHaveLength(scene.prims.length)
    expect(meshes.find(m => m.name === 'board')?.userData.tag).toEqual({ kind: 'board', id: 'board' })
    prims.forEach((m, i) => {
      expect(m.isMesh).toBe(true)
      expect(m.userData.tag).toBe(scene.prims[i]!.tag)
    })
  })

  it('places prims where the scene says', () => {
    const { group } = buildMeshes(scene)
    const prims = group.children.filter(m => m.userData.tag && m.name !== 'board')
    scene.prims.forEach((p, i) => {
      const box = new THREE.Box3().setFromObject(prims[i]!)
      const c = box.getCenter(new THREE.Vector3())
      if (p.kind === 'box' && !p.rotY) {
        expect(c.x).toBeCloseTo(p.center[0], 5)
        expect(c.y).toBeCloseTo(p.center[1], 5)
        expect(c.z).toBeCloseTo(p.center[2], 5)
      } else if (p.kind === 'cone') {
        expect(c.x).toBeCloseTo(p.base[0], 5)
        expect(c.y).toBeCloseTo(p.base[1] + p.up * p.height / 2, 5)
      } else if (p.kind === 'cylinder') {
        expect(c.x).toBeCloseTo((p.a[0] + p.b[0]) / 2, 4)
        expect(c.y).toBeCloseTo((p.a[1] + p.b[1]) / 2, 4)
        expect(c.z).toBeCloseTo((p.a[2] + p.b[2]) / 2, 4)
      }
    })
  })

  it('dispose releases everything', () => {
    const geo = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    const mat = vi.spyOn(THREE.Material.prototype, 'dispose')
    const built = buildMeshes(scene)
    const { geometries, materials } = collect(built.group)
    geo.mockClear()
    mat.mockClear()
    built.dispose()
    const disposedGeo = new Set(geo.mock.contexts)
    const disposedMat = new Set(mat.mock.contexts)
    expect(geometries.size).toBeGreaterThan(3)
    for (const g of geometries) expect(disposedGeo.has(g)).toBe(true)
    for (const m of materials) expect(disposedMat.has(m)).toBe(true)
    expect(built.group.children).toHaveLength(0)
  })
})

describe('highlight and marks', () => {
  const board = board2()
  const scene = buildScene(board)

  it('setHighlight dims other nets and restores', () => {
    const built = buildMeshes(scene)
    const meshes = primMeshes(built.group)
    expect(meshes).toHaveLength(scene.prims.length)
    const original = new Map(meshes.map(m => [m, m.material as THREE.Material]))
    const net = (m: THREE.Mesh) => (m.userData.tag as Tag).net
    const gnd = meshes.filter(m => net(m) === 'GND')
    const rest = meshes.filter(m => net(m) !== 'GND')
    expect(gnd.length).toBeGreaterThan(0)
    // Some GND mesh shares its material (the copper colour) with a mesh of another net.
    expect(gnd.some(g => rest.some(r => original.get(r) === original.get(g)))).toBe(true)

    setHighlight(meshes, ['GND'])
    for (const m of gnd) {
      expect(m.material).toBe(original.get(m))
      expect((m.material as THREE.Material).transparent).toBe(false)
      expect((m.material as THREE.Material).opacity).toBe(1)
    }
    for (const m of rest) {
      const mat = m.material as THREE.Material
      expect(mat).not.toBe(original.get(m))
      expect(mat.transparent).toBe(true)
      expect(mat.opacity).toBe(0.25)
    }
    // The shared originals are untouched.
    for (const mat of original.values()) {
      expect(mat.transparent).toBe(false)
      expect(mat.opacity).toBe(1)
    }

    // Another net, then none: every mesh gets its own original back.
    setHighlight(meshes, ['V12'])
    expect(meshes.filter(m => net(m) === 'V12').every(m => m.material === original.get(m))).toBe(true)
    expect(gnd.every(m => (m.material as THREE.Material).opacity === 0.25)).toBe(true)
    setHighlight(meshes, [])
    for (const m of meshes) expect(m.material).toBe(original.get(m))

    // The dim variants are released by dispose, even while in use.
    setHighlight(meshes, ['GND'])
    const dims = new Set(rest.map(m => m.material as THREE.Material))
    const spy = vi.spyOn(THREE.Material.prototype, 'dispose')
    built.dispose()
    const disposed = new Set(spy.mock.contexts)
    for (const m of [...dims, ...original.values()]) expect(disposed.has(m)).toBe(true)
  })

  it('finding marks make rings at the holes on both sides', () => {
    const at = [{ x: 0, z: 0 }, { x: 2.54 * 6, z: 2.54 * 12 }]
    const marks = markRings(scene, at)
    const rings = marks.children[0] as THREE.InstancedMesh
    expect(rings.isInstancedMesh).toBe(true)
    expect(rings.count).toBe(at.length * 2)
    expect((rings.material as THREE.MeshBasicMaterial).color.getHexString()).toBe(MARK_COLOR.slice(1))
    expect(MARK_COLOR).toBe('#e11d48')
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const seen: string[] = []
    for (let i = 0; i < rings.count; i++) {
      rings.getMatrixAt(i, m)
      p.setFromMatrixPosition(m)
      const side = p.y > 0 ? 'top' : p.y < -BOARD_THICKNESS_MM ? 'bottom' : 'inside'
      seen.push(`${p.x.toFixed(2)},${p.z.toFixed(2)},${side}`)
    }
    expect(seen.sort()).toEqual(['0.00,0.00,bottom', '0.00,0.00,top', '15.24,30.48,bottom', '15.24,30.48,top'])
    // Dashed: the ring geometry is several separate arcs, not one closed ring.
    const box = new THREE.Box3().setFromBufferAttribute(rings.geometry.getAttribute('position') as THREE.BufferAttribute)
    expect(box.max.x).toBeCloseTo(1.7, 1)
    const pos = rings.geometry.getAttribute('position')
    const angles = Array.from({ length: pos.count }, (_, i) => Math.atan2(pos.getZ(i), pos.getX(i))).sort((a, b) => a - b)
    const gap = Math.max(...angles.slice(1).map((a, i) => a - angles[i]!))
    expect(gap).toBeGreaterThan(0.15)

    const geo = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    const mat = vi.spyOn(THREE.Material.prototype, 'dispose')
    const g = rings.geometry
    const mm = rings.material
    dispose(marks)
    expect(geo.mock.contexts).toContain(g)
    expect(mat.mock.contexts).toContain(mm)
    expect(markRings(scene, []).children).toHaveLength(0)
  })

  it('tagTip reads like the 2D tooltip', () => {
    expect(tagTip({ kind: 'part', id: 'QA', label: 'QA' }, board)).toEqual({ name: 'QA', lines: ['MOSFET IRLB3813'], net: null })
    expect(tagTip({ kind: 'part', id: 'RGA', label: 'RGA 10R' }, board)).toEqual({ name: 'RGA', lines: ['RGA 10R'], net: null })
    expect(tagTip({ kind: 'leg', id: 'QA.1', net: 'GATE_A', label: 'QA pin 1' }, board)).toEqual({ name: 'QA pin 1', lines: [], net: 'GATE_A' })
    expect(tagTip({ kind: 'trail', id: 'T1', net: null, label: 'trail T1' }, board)).toEqual({ name: 'trail T1', lines: [], net: 'no net' })
    expect(tagTip({ kind: 'board', id: 'board' }, board)).toBeNull()
  })
})

describe('webglAvailable', () => {
  it('is false without a document', () => {
    vi.stubGlobal('document', undefined)
    expect(webglAvailable()).toBe(false)
  })
  it('is false when the canvas gives no context', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) })
    expect(webglAvailable()).toBe(false)
  })
  it('is true when the canvas gives a webgl context', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: (k: string) => (k === 'webgl2' ? {} : null) }) })
    expect(webglAvailable()).toBe(true)
  })
})
