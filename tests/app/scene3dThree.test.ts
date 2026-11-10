import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { parseBoard, type BoardFile } from '~core/schema'
import { axial, mk, trail } from '../core/helpers'
import { BOARD_THICKNESS_MM, buildScene, COLORS, type Scene3D, type Tag } from '~core/scene3d'
import { buildMeshes, dispose, labelMesh, markRings, markVisibility, MARK_COLOR, primMeshes, resetWebglProbe, setHighlight, tagTip, webglAvailable } from '../../app/utils/scene3dThree'

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
    const all = marks.children as THREE.InstancedMesh[]
    expect(all).toHaveLength(2)
    const rings = all[0]!
    expect(MARK_COLOR).toBe('#e11d48')
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const seen: string[] = []
    for (const r of all) {
      expect(r.isInstancedMesh).toBe(true)
      expect(r.count).toBe(at.length)
      expect((r.material as THREE.MeshBasicMaterial).color.getHexString()).toBe(MARK_COLOR.slice(1))
      for (let i = 0; i < r.count; i++) {
        r.getMatrixAt(i, m)
        p.setFromMatrixPosition(m)
        const side = p.y > 0 ? 'top' : p.y < -BOARD_THICKNESS_MM ? 'bottom' : 'inside'
        expect(r.name).toBe(`marks-${side}`)
        seen.push(`${p.x.toFixed(2)},${p.z.toFixed(2)},${side}`)
      }
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
    const owned = all.flatMap(r => [r.geometry, r.material as THREE.Material])
    dispose(marks)
    for (const o of owned) expect([...geo.mock.contexts, ...mat.mock.contexts]).toContain(o)
    expect(markRings(scene, []).children).toHaveLength(0)
  })

  it('tagTip reads like the 2D tooltip', () => {
    expect(tagTip({ kind: 'part', id: 'QA', label: 'QA' }, board)).toEqual({ name: 'QA', lines: ['MOSFET IRLB3813'], net: null })
    expect(tagTip({ kind: 'part', id: 'RGA', label: 'RGA 10R' }, board)).toEqual({ name: 'RGA', lines: ['RGA 10R'], net: null })
    expect(tagTip({ kind: 'leg', id: 'QA.1', net: 'GATE_A', label: 'QA pin 1' }, board)).toEqual({ name: 'QA pin 1', lines: [], net: 'GATE_A' })
    expect(tagTip({ kind: 'trail', id: 'T1', net: null, label: 'trail T1' }, board)).toEqual({ name: 'trail T1', lines: [], net: 'no net' })
    expect(tagTip({ kind: 'board', id: 'board' }, board)).toBeNull()
    expect(tagTip({ kind: 'trail', id: 'T1', net: null, nets: ['GND', 'V12'], label: 'trail T1' }, board))
      .toEqual({ name: 'trail T1', lines: [], net: 'short: GND + V12' })
    expect(tagTip({ kind: 'leg', id: 'QA.1', net: 'GATE_A', nets: ['GATE_A'], label: 'QA pin 1' }, board)?.net).toBe('GATE_A')
    expect(tagTip({ kind: 'trail', id: 'T1', net: null, nets: [], label: 'trail T1' }, board)?.net).toBe('no net')
  })

  it('setHighlight lights a shorted group as one', () => {
    const shorted = buildScene(mk({
      nets: { GND: {}, V12: {}, SIG: {} },
      parts: [axial('R1', 'B2', 'E2', 'GND'), axial('R2', 'B6', 'E6', 'V12'), axial('R3', 'H2', 'H6', 'SIG')],
      trails: [trail('T1', ['B2', 'B4'], 'bottom'), trail('T2', ['B4', 'B6'], 'bottom')]
    }))
    const meshes = primMeshes(buildMeshes(shorted).group)
    const tag = (m: THREE.Mesh) => m.userData.tag as Tag
    const t1 = meshes.find(m => tag(m).kind === 'trail' && tag(m).id === 'T1')!
    // What hovering T1 asks for (index.vue): its group's nets.
    setHighlight(meshes, tag(t1).nets!)
    const lit = (m: THREE.Mesh) => !(m.material as THREE.Material).transparent
    expect(lit(meshes.find(m => tag(m).kind === 'trail' && tag(m).id === 'T2')!)).toBe(true)
    expect(lit(meshes.find(m => tag(m).kind === 'leg' && tag(m).id === 'R1.a')!)).toBe(true)
    expect(lit(meshes.find(m => tag(m).kind === 'leg' && tag(m).id === 'R2.a')!)).toBe(true)
    expect(lit(meshes.find(m => tag(m).kind === 'leg' && tag(m).id === 'R3.a')!)).toBe(false)
  })

  it('marks show on the side the camera is on', () => {
    const marks = markRings(scene, [{ x: 0, z: 0 }])
    const top = marks.getObjectByName('marks-top') as THREE.Mesh
    const bottom = marks.getObjectByName('marks-bottom') as THREE.Mesh
    expect((top.material as THREE.Material).depthTest).toBe(false)
    expect(top.renderOrder).toBeGreaterThan(0)
    const cam = new THREE.PerspectiveCamera()
    cam.position.set(20, 80, 30)
    markVisibility(marks, scene, cam)
    expect([top.visible, bottom.visible]).toEqual([true, false])
    cam.position.set(20, -80, 30)
    markVisibility(marks, scene, cam)
    expect([top.visible, bottom.visible]).toEqual([false, true])
    // Edge-on, inside the slab's thickness: neither, so nothing shows through the board.
    cam.position.set(200, -0.8, 30)
    markVisibility(marks, scene, cam)
    expect([top.visible, bottom.visible]).toEqual([false, false])
  })
})

describe('webglAvailable', () => {
  beforeEach(() => resetWebglProbe())

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

describe('webglAvailable probe', () => {
  beforeEach(() => resetWebglProbe())

  const stub = (ok: boolean) => {
    const loseContext = vi.fn()
    const gl = { getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext } : null) }
    const getContext = vi.fn((k: string) => (ok && k === 'webgl2' ? gl : null))
    const createElement = vi.fn(() => ({ getContext }))
    vi.stubGlobal('document', { createElement })
    return { createElement, getContext, loseContext }
  }

  it('probes once across calls and frees the probe context', () => {
    const { createElement, loseContext } = stub(true)
    expect([webglAvailable(), webglAvailable(), webglAvailable()]).toEqual([true, true, true])
    expect(createElement).toHaveBeenCalledTimes(1)
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('remembers a no as well', () => {
    const { createElement } = stub(false)
    expect([webglAvailable(), webglAvailable()]).toEqual([false, false])
    expect(createElement).toHaveBeenCalledTimes(1)
  })
})

describe('metal by material', () => {
  /** A one-prim scene per case, on a bare board. */
  const sceneOf = (prims: Scene3D['prims']): Scene3D => ({
    board: { widthMm: 10, depthMm: 10, thicknessMm: 1.6, center: [5, -0.8, 5] },
    holes: [], pads: { top: [], bottom: [] }, labels: [], prims, bounds: { min: [0, -2, 0], max: [10, 2, 10] }, skipped: []
  })

  it('metal prims get a metallic material, the rest a plain one, whatever the tag kind', () => {
    const wireTag: Tag = { kind: 'wire', id: 'W1', net: null }
    const partTag: Tag = { kind: 'part', id: 'QA' }
    const built = buildMeshes(sceneOf([
      { kind: 'tube', points: [[0, 0.3, 0], [5, 0.3, 0]], radius: 0.3, color: COLORS.copper, metal: true, tag: wireTag },
      { kind: 'tube', points: [[5, 0.7, 0], [9, 0.7, 0]], radius: 0.7, color: COLORS.copper, tag: wireTag },
      { kind: 'box', center: [5, 5, 5], size: [1, 10, 4], color: COLORS.tab, metal: true, tag: partTag },
      { kind: 'box', center: [3, 3, 5], size: [4, 6, 4], color: COLORS.black, tag: partTag }
    ]))
    const [bare, insulated, tab, body] = primMeshes(built.group).map(m => m.material as THREE.MeshStandardMaterial)
    expect(bare!.metalness).toBeGreaterThan(0)
    expect(tab!.metalness).toBeGreaterThan(0)
    expect(insulated!.metalness).toBe(0)
    expect(body!.metalness).toBe(0)
    // Same colour, different finish: two materials.
    expect(bare).not.toBe(insulated)
    built.dispose()
  })

  it('board 2: bare copper stretches, header posts and the TO-220 tab look metallic', () => {
    const scene = buildScene(board2())
    const built = buildMeshes(scene)
    const meshes = primMeshes(built.group)
    const metalness = (m: THREE.Mesh) => (m.material as THREE.MeshStandardMaterial).metalness
    meshes.forEach((m, i) => {
      const p = scene.prims[i]!
      expect(metalness(m) > 0, `${p.tag.kind} ${p.tag.id} ${p.color}`).toBe(!!p.metal)
    })
    expect(meshes.some((m, i) => scene.prims[i]!.color === COLORS.headerPin && metalness(m) > 0)).toBe(true)
    expect(meshes.some((m, i) => scene.prims[i]!.color === COLORS.tab && metalness(m) > 0)).toBe(true)
    built.dispose()
  })
})

describe('printed edge labels', () => {
  /** A stand-in for a browser canvas: enough 2D context for the atlas. */
  const fakeCanvas = () => {
    const drawn: string[] = []
    const ctx = {
      font: '', fillStyle: '', textAlign: '', textBaseline: '',
      measureText: (t: string) => ({ width: t.length * 30 }),
      fillRect: vi.fn(),
      fillText: (t: string) => drawn.push(t)
    }
    const canvas = { width: 0, height: 0, getContext: (k: string) => (k === '2d' ? ctx : null) }
    return { canvas: canvas as unknown as HTMLCanvasElement, drawn }
  }
  const scene = buildScene(mk({ board: { cols: 4, rows: 3 } }))

  it('one mesh and one texture for every label, each text drawn once in the atlas', () => {
    const { canvas, drawn } = fakeCanvas()
    const mesh = labelMesh(scene, canvas)!
    expect(mesh.name).toBe('labels')
    expect(mesh.userData.tag).toBeUndefined() // not hoverable, not dimmed
    expect(mesh.geometry.getIndex()!.count).toBe(scene.labels.length * 6)
    expect([...drawn].sort()).toEqual(['1', '2', '3', '4', 'A', 'B', 'C'])
    const mat = mesh.material as THREE.MeshStandardMaterial
    expect(mat.alphaMap).toBeInstanceOf(THREE.CanvasTexture)
    expect(mat.color.getHexString()).toBe(new THREE.Color(COLORS.print).getHexString())
    // Flat on the top surface, a hair above it, and facing up.
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!
    expect(box.min.y).toBeGreaterThan(0)
    expect(box.max.y).toBeLessThan(0.01)
    expect(box.max.y - box.min.y).toBeLessThan(1e-9)
    const n = mesh.geometry.getAttribute('normal')
    for (let i = 0; i < n.count; i++) expect(n.getY(i)).toBeCloseTo(1)
    // Text up is -z (row A), so it reads upright in the top and iso views: v is larger at smaller z.
    const pos = mesh.geometry.getAttribute('position')
    const uv = mesh.geometry.getAttribute('uv')
    expect(pos.getZ(0)).toBeLessThan(pos.getZ(1))
    expect(uv.getY(0)).toBeGreaterThan(uv.getY(1))
  })

  it('quads are centred on the scene labels', () => {
    const { canvas } = fakeCanvas()
    const mesh = labelMesh(scene, canvas)!
    const pos = mesh.geometry.getAttribute('position')
    scene.labels.forEach((l, i) => {
      let x = 0
      let z = 0
      for (let k = 0; k < 4; k++) {
        x += pos.getX(i * 4 + k) / 4
        z += pos.getZ(i * 4 + k) / 4
      }
      expect(x).toBeCloseTo(l.x, 5)
      expect(z).toBeCloseTo(l.z, 5)
    })
  })

  it('buildMeshes adds the labels when a canvas is there, and dispose frees the texture', () => {
    const { canvas } = fakeCanvas()
    vi.stubGlobal('document', { createElement: () => canvas })
    const tex = vi.spyOn(THREE.Texture.prototype, 'dispose')
    const built = buildMeshes(scene)
    const labels = built.group.getObjectByName('labels') as THREE.Mesh
    expect(labels).toBeTruthy()
    expect(primMeshes(built.group)).not.toContain(labels)
    const map = (labels.material as THREE.MeshStandardMaterial).alphaMap!
    built.dispose()
    expect(tex.mock.contexts).toContain(map)
  })

  it('no canvas (no DOM): no labels, no error', () => {
    expect(labelMesh(scene, null)).toBeNull()
    const built = buildMeshes(scene)
    expect(built.group.getObjectByName('labels')).toBeUndefined()
    built.dispose()
  })
})

describe('extrude and lathe meshes', () => {
  const tag: Tag = { kind: 'part', id: 'X1' }
  const sceneOf = (prims: Scene3D['prims']): Scene3D => ({
    board: { widthMm: 10, depthMm: 10, thicknessMm: 1.6, center: [5, -0.8, 5] }, holes: [], pads: { top: [], bottom: [] },
    labels: [], prims, bounds: { min: [0, -2, 0], max: [10, 10, 10] }, skipped: []
  })
  const boxOf = (built: ReturnType<typeof buildMeshes>) => {
    const m = primMeshes(built.group)[0]!
    m.updateMatrixWorld(true)
    return new THREE.Box3().setFromObject(m)
  }
  const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 3))

  it('an extrude stands on its outline from y0 to y1, either winding', () => {
    const ccw = [{ x: 1, z: 2 }, { x: 4, z: 2 }, { x: 4, z: 6 }, { x: 1, z: 6 }]
    for (const outline of [ccw, [...ccw].reverse()]) {
      const built = buildMeshes(sceneOf([{ kind: 'extrude', outline, y0: 0.5, y1: 3, color: '#123456', tag }]))
      const b = boxOf(built)
      near([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z], [1, 0.5, 2, 4, 3, 6])
      expect(primMeshes(built.group)[0]!.userData.tag).toEqual(tag)
      built.dispose()
    }
  })

  it('a lathe is spun round its axis', () => {
    const built = buildMeshes(sceneOf([{ kind: 'lathe', axis: { x: 5, z: 3 }, profile: [{ r: 0, y: 1 }, { r: 2, y: 1 }, { r: 2, y: 5 }, { r: 0, y: 6 }], color: '#aa0000', tag }]))
    const b = boxOf(built)
    near([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z], [3, 1, 1, 7, 6, 5])
    built.dispose()
  })
})
