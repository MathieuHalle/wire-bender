import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { parseBoard, type BoardFile } from '~core/schema'
import { buildScene } from '~core/scene3d'
import { buildMeshes, webglAvailable } from '../../app/utils/scene3dThree'

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
