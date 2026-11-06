import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBoard, type BoardFile } from '~core/schema'
import { buildScene, dedupCones, type Prim, type Tag } from '~core/scene3d'
import { ALL_LAYERS, blindHint, visibleTag, type Layers } from '../../app/utils/layers'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const only = (off: keyof Layers): Layers => ({ ...ALL_LAYERS, [off]: false })
const NONE: Layers = { components: false, wires: false, trails: false }

describe('visibleTag', () => {
  it('shows everything with every layer on', () => {
    expect(ALL_LAYERS).toEqual({ components: true, wires: true, trails: true })
    for (const kind of ['board', 'part', 'leg', 'trail', 'wire', 'joint', 'fold', 'bridge'] as const)
      expect(visibleTag({ kind, id: 'x' }, ALL_LAYERS), kind).toBe(true)
  })

  it('never hides the slab, or an untagged mesh', () => {
    expect(visibleTag({ kind: 'board', id: 'board' }, NONE)).toBe(true)
    expect(visibleTag(undefined, NONE)).toBe(true)
  })

  it('Components hides part bodies, legs and part-lead joints', () => {
    const l = only('components')
    expect(visibleTag({ kind: 'part', id: 'U1' }, l)).toBe(false)
    expect(visibleTag({ kind: 'leg', id: 'U1.3' }, l)).toBe(false)
    expect(visibleTag({ kind: 'joint', id: 'U1.3', owners: ['part'] }, l)).toBe(false)
    // A leg-fold's joints carry a lead id too, but follow Trails.
    expect(visibleTag({ kind: 'joint', id: 'U1.3', owners: ['fold'] }, l)).toBe(true)
    expect(visibleTag({ kind: 'fold', id: 'U1.3' }, l)).toBe(true)
    expect(visibleTag({ kind: 'trail', id: 'T1' }, l)).toBe(true)
    expect(visibleTag({ kind: 'wire', id: 'W1' }, l)).toBe(true)
  })

  it('Trails hides trails, their joints, leg-folds and their joints, and bridges', () => {
    const l = only('trails')
    expect(visibleTag({ kind: 'trail', id: 'T1' }, l)).toBe(false)
    expect(visibleTag({ kind: 'joint', id: 'T1', owners: ['trail'] }, l)).toBe(false)
    expect(visibleTag({ kind: 'fold', id: 'U1.3' }, l)).toBe(false)
    expect(visibleTag({ kind: 'joint', id: 'U1.3', owners: ['fold'] }, l)).toBe(false)
    expect(visibleTag({ kind: 'bridge', id: 'A1-A2' }, l)).toBe(false)
    expect(visibleTag({ kind: 'joint', id: 'U1.3', owners: ['part'] }, l)).toBe(true)
    expect(visibleTag({ kind: 'joint', id: 'W1', owners: ['wire'] }, l)).toBe(true)
    expect(visibleTag({ kind: 'part', id: 'U1' }, l)).toBe(true)
  })

  it('Wires hides wires and their end cones', () => {
    const l = only('wires')
    expect(visibleTag({ kind: 'wire', id: 'W1' }, l)).toBe(false)
    expect(visibleTag({ kind: 'joint', id: 'W1', owners: ['wire'] }, l)).toBe(false)
    expect(visibleTag({ kind: 'joint', id: 'T1', owners: ['trail'] }, l)).toBe(true)
    expect(visibleTag({ kind: 'leg', id: 'U1.3' }, l)).toBe(true)
  })

  it('a joint without an owner stays visible', () => {
    expect(visibleTag({ kind: 'joint', id: 'x' }, NONE)).toBe(true)
    expect(visibleTag({ kind: 'joint', id: 'x', owners: [] }, NONE)).toBe(true)
  })

  it('a shared joint shows while any of its owners does', () => {
    const tag: Tag = { kind: 'joint', id: 'U1.3', owners: ['part', 'trail'] }
    expect(visibleTag(tag, only('components'))).toBe(true)
    expect(visibleTag(tag, only('trails'))).toBe(true)
    expect(visibleTag(tag, { ...ALL_LAYERS, components: false, trails: false })).toBe(false)
  })
})

describe('joint owners in the 3D scene', () => {
  const s = buildScene(board2())
  const joints = s.prims.map(p => p.tag).filter((t): t is Tag => t.kind === 'joint')

  it('every joint cone names its owners, without repeats', () => {
    expect(joints.length).toBeGreaterThan(0)
    for (const t of joints) {
      expect(t.owners?.length, t.label).toBeGreaterThan(0)
      for (const o of t.owners!) expect(['part', 'trail', 'wire', 'fold'], t.label).toContain(o)
      expect(new Set(t.owners).size, t.label).toBe(t.owners!.length)
    }
  })

  it('the drawn owner comes first and matches the id: trails, wires, part leads and leg-folds', () => {
    const b = board2()
    const trailIds = new Set(b.trails.map(t => t.id))
    const wireIds = new Set(b.wires.map(w => w.id))
    for (const t of joints) {
      const first = t.owners![0]
      if (first === 'trail') expect(trailIds.has(t.id), t.id).toBe(true)
      if (first === 'wire') expect(wireIds.has(t.id), t.id).toBe(true)
      if (first === 'part' || first === 'fold') expect(t.id, t.id).toMatch(/\./)
    }
    for (const owner of ['part', 'trail', 'wire'] as const)
      expect(joints.some(t => t.owners![0] === owner), owner).toBe(true)
    // Board 2's fold cones all sit where a part lead or a trail joint is already drawn.
    if (b.legFolds.length) expect(joints.some(t => t.owners!.includes('fold'))).toBe(true)
    // A trail end soldered on a part lead: one cone, owned by both.
    expect(joints.some(t => t.owners![0] === 'part' && t.owners!.includes('trail'))).toBe(true)
  })

  it('dedupCones merges owners into a copy and leaves its input alone', () => {
    const cone = (owners: Tag['owners']): Prim => ({
      kind: 'cone', base: [1, 0, 2], up: -1, radius: 1, height: 1, color: '#000',
      tag: { kind: 'joint', id: 'x', owners }
    })
    const a = cone(['part'])
    const out = dedupCones([a, cone(['trail']), cone(['part', 'wire'])])
    expect(out).toHaveLength(1)
    expect(out[0]!.tag.owners).toEqual(['part', 'trail', 'wire'])
    expect(a.tag.owners).toEqual(['part'])
  })

  it('with every layer off only the slab is left among the tagged prims', () => {
    expect(s.prims.filter(p => visibleTag(p.tag, NONE))).toEqual([])
  })
})

describe('blindHint', () => {
  it('warns while an editing tool is on with Trails hidden', () => {
    for (const t of ['pencil', 'erase', 'joint'] as const)
      expect(blindHint(t, only('trails')), t).toMatch(/Trails are hidden/)
  })
  it('says nothing for Inspect, or with Trails shown', () => {
    expect(blindHint('inspect', only('trails'))).toBeNull()
    expect(blindHint('pencil', ALL_LAYERS)).toBeNull()
    expect(blindHint('pencil', only('wires'))).toBeNull()
  })
})
