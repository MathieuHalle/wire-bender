import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBoard, type BoardFile } from '~core/schema'
import { buildScene } from '~core/scene3d'
import { placePart } from '~core/footprints'
import { holeName } from '~core/holes'
import { buildConnectivity } from '~core/connectivity'
import { ALL_LAYERS, type Layers } from '../../app/utils/layers'
import {
  boardItems, drawnBoard, drawnPlaced, editTarget, groupState, hiddenCount, HIDDEN_PREFIX, hiddenKey, itemKey,
  itemLit, itemNets, itemsAtFinding, loadHidden, matchItems, parseHidden, pruneHidden, saveHidden, setShown, showAll, toggleGroup,
  type ViewState
} from '../../app/utils/hiddenItems'

function board2(): BoardFile {
  const res = parseBoard(JSON.parse(readFileSync(new URL('../fixtures/channel-board-2.json', import.meta.url), 'utf8')))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

/** A Map-backed Storage, enough for get/set. */
function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v)
  }
}

const throwing = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  }
}

const state = (hidden: string[] = [], layers: Partial<Layers> = {}): ViewState =>
  ({ layers: { ...ALL_LAYERS, ...layers }, hidden })

describe('boardItems', () => {
  const b = board2()
  const items = boardItems(b)

  it('lists every part, wire and trail, in board order, with a kind-prefixed key', () => {
    expect(items.part.map(i => i.id)).toEqual(b.parts.map(p => p.ref))
    expect(items.wire.map(i => i.id)).toEqual(b.wires.map(w => w.id))
    expect(items.trail.map(i => i.id)).toEqual(b.trails.map(t => t.id))
    expect(items.trail).toHaveLength(35)
    expect(items.part[0]!.key).toBe('part:JA')
    expect(itemKey('trail', 'T1')).toBe('trail:T1')
  })

  it('names parts by ref and value, wires and trails by id and side', () => {
    const u1 = items.part.find(i => i.id === 'U1')!
    expect(u1.label).toBe('U1 TC4426 gate driver')
    expect(items.part.find(i => i.id === 'RGA')!.label).toBe('RGA 10R')
    expect(items.part.find(i => i.id === 'JA')!.label).toBe('JA Screw terminal 2-pos')
    const p0 = b.parts[0]!
    const label = (part: Partial<typeof p0>) => boardItems({ ...b, parts: [{ ...p0, ...part }] }).part[0]!.label
    expect(label({ ref: 'R1', value: '10k', label: 'whatever' })).toBe('R1 10k')
    expect(label({ ref: 'R1', value: undefined, label: 'pull-up' })).toBe('R1 pull-up')
    expect(label({ ref: 'R1', value: undefined, label: undefined })).toBe('R1')
    expect(items.wire.find(i => i.id === 'W5')!.label).toBe('W5')
    expect(items.wire.find(i => i.id === 'W5')!.detail).toBe('bottom, flying')
    const laid = boardItems({ ...b, wires: [{ ...b.wires[0]!, kind: 'laid', side: 'top', points: ['A1', 'A3'] }] }).wire[0]!
    expect(laid.detail).toBe('top')
    expect(laid.holes.map(holeName)).toEqual(['A1', 'A2', 'A3'])
    expect(items.trail[0]!.detail).toBe('bottom')
  })

  it('knows the holes each item covers', () => {
    const u1 = items.part.find(i => i.id === 'U1')!
    expect(u1.holes).toEqual(placePart(b.parts.find(p => p.ref === 'U1')!).pins.map(p => p.hole))
    const t = b.trails[0]!
    const ti = items.trail[0]!
    const names = ti.holes.map(holeName)
    for (const p of t.points) expect(names).toContain(p)
    expect(ti.holes.length).toBeGreaterThanOrEqual(t.points.length)
  })
})

describe('matchItems: the filter', () => {
  const b = board2()
  const items = boardItems({
    ...b,
    wires: b.wires.map((w, i) => (i === 4 ? w : { ...w, kind: 'laid' as const, side: (i === 5 ? 'top' : 'bottom') as 'top' | 'bottom', points: ['A1', 'A2'] }))
  })
  it('an empty or blank filter keeps every item', () => {
    expect(matchItems(items.part, '')).toEqual(items.part)
    expect(matchItems(items.part, '   ')).toEqual(items.part)
  })
  it('matches the name and the side, ignoring case', () => {
    expect(matchItems(items.part, 'tc44').map(i => i.id)).toEqual(['U1'])
    expect(matchItems(items.part, 'da').map(i => i.id)).toEqual(['DA1', 'DA2', 'DA3', 'DA4', 'DA5', 'DA6', 'DA7'])
    expect(matchItems(items.wire, 'FLYING').map(i => i.id)).toEqual(['W5'])
    expect(matchItems(items.trail, 't1').map(i => i.id)).toEqual(['T1', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T18', 'T19'])
  })
  it('every word must match', () => {
    expect(matchItems(items.wire, 'w top').map(i => i.id)).toEqual(['W6'])
    expect(matchItems(items.wire, 'bottom fly').map(i => i.id)).toEqual(['W5'])
    expect(matchItems(items.wire, 'zz')).toEqual([])
  })
})

describe('groupState: the tri-state of a group', () => {
  const items = boardItems(board2()).wire
  it('all shown, none shown, some shown', () => {
    expect(groupState('wire', items, state())).toBe('shown')
    expect(groupState('wire', items, state(items.map(i => i.key)))).toBe('hidden')
    expect(groupState('wire', items, state(['wire:W1']))).toBe('mixed')
  })
  it('a group whose layer is off is hidden', () => {
    expect(groupState('wire', items, state([], { wires: false }))).toBe('hidden')
    expect(groupState('wire', [], state([], { wires: false }))).toBe('hidden')
    expect(groupState('wire', [], state())).toBe('shown')
  })
  it('ids of other kinds do not count', () => {
    expect(groupState('wire', items, state(['trail:T1', 'part:U1']))).toBe('shown')
  })
})

describe('toggleGroup, setShown, showAll', () => {
  const items = boardItems(board2())
  const wires = items.wire

  it('a shown group hides as a whole (its layer goes off)', () => {
    expect(toggleGroup('wire', wires, state(['trail:T1']))).toEqual(state(['trail:T1'], { wires: false }))
  })
  it('a mixed or hidden group shows all of its items', () => {
    expect(toggleGroup('wire', wires, state(['wire:W1', 'trail:T1']))).toEqual(state(['trail:T1']))
    expect(toggleGroup('wire', wires, state(['wire:W2'], { wires: false }))).toEqual(state())
  })
  it('hides and shows single items', () => {
    expect(setShown(['wire:W1'], false, items, state())).toEqual(state(['wire:W1']))
    expect(setShown(['wire:W1'], false, items, state(['wire:W1']))).toEqual(state(['wire:W1']))
    expect(setShown(['wire:W1'], true, items, state(['wire:W1', 'part:U1']))).toEqual(state(['part:U1']))
  })
  it('showing one item of a group whose layer is off shows only that one', () => {
    const s = setShown(['wire:W3'], true, items, state([], { wires: false }))
    expect(s.layers.wires).toBe(true)
    expect(new Set(s.hidden)).toEqual(new Set(wires.filter(w => w.id !== 'W3').map(w => w.key)))
    expect(groupState('wire', wires, s)).toBe('mixed')
  })
  it('showAll turns every layer on and clears the hidden ids', () => {
    expect(showAll(state(['wire:W1'], { trails: false, components: false }))).toEqual(state())
  })
  it('counts what is hidden, once per item', () => {
    expect(hiddenCount(items, state())).toBe(0)
    expect(hiddenCount(items, state(['wire:W1', 'part:U1']))).toBe(2)
    expect(hiddenCount(items, state(['wire:W1'], { wires: false }))).toBe(wires.length)
    expect(hiddenCount(items, state(['wire:W404']))).toBe(0)
  })
})

describe('pruneHidden: stale ids', () => {
  const b = board2()
  it('drops ids the board no longer has, and junk', () => {
    expect(pruneHidden(['part:U1', 'part:NOPE', 'trail:T1', 'trail:T999', 'wire:W1', 'bogus', 'wire:'], b))
      .toEqual(['part:U1', 'trail:T1', 'wire:W1'])
  })
  it('drops the flag of a deleted item', () => {
    const without = { ...b, trails: b.trails.filter(t => t.id !== 'T1') }
    expect(pruneHidden(['trail:T1', 'trail:T2'], without)).toEqual(['trail:T2'])
  })
  it('keeps the same array when nothing is stale', () => {
    const h = ['trail:T1']
    expect(pruneHidden(h, b)).toBe(h)
  })
})

describe('drawnBoard: what the 2D and 3D views draw', () => {
  const b = board2()
  const hidden = new Set(['part:U1', 'wire:W1', 'trail:T1', 'trail:T404'])

  it('leaves hidden items out of a copy; the board itself is untouched', () => {
    const before = JSON.stringify(b)
    const d = drawnBoard(b, hidden)
    expect(d.parts.map(p => p.ref)).not.toContain('U1')
    expect(d.wires.map(w => w.id)).not.toContain('W1')
    expect(d.trails.map(t => t.id)).not.toContain('T1')
    expect(d.parts).toHaveLength(b.parts.length - 1)
    expect(d.wires).toHaveLength(b.wires.length - 1)
    expect(d.trails).toHaveLength(b.trails.length - 1)
    expect(JSON.stringify(b)).toBe(before)
  })

  it('a hidden part takes its leg-folds with it', () => {
    const fold = b.legFolds[0]
    if (!fold) return
    const ref = fold.lead.slice(0, fold.lead.lastIndexOf('.'))
    const d = drawnBoard(b, new Set([`part:${ref}`]))
    expect(d.legFolds.some(f => f.lead.startsWith(`${ref}.`))).toBe(false)
  })

  it('returns the board itself when nothing is hidden', () => {
    expect(drawnBoard(b, new Set())).toBe(b)
    expect(drawnBoard(b, new Set(['trail:T404']))).toBe(b)
  })

  it('the 2D draw list leaves hidden parts out', () => {
    const placed = b.parts.map(placePart)
    expect(drawnPlaced(placed, hidden).map(p => p.part.ref)).not.toContain('U1')
    expect(drawnPlaced(placed, hidden)).toHaveLength(placed.length - 1)
    expect(drawnPlaced(placed, new Set())).toBe(placed)
  })

  it('the 3D scene input has no prim of a hidden item', () => {
    const tags = buildScene(drawnBoard(b, hidden)).prims.map(p => p.tag)
    expect(tags.some(t => t.kind === 'part' && t.id === 'U1')).toBe(false)
    expect(tags.some(t => t.kind === 'leg' && t.id.startsWith('U1.'))).toBe(false)
    expect(tags.some(t => t.kind === 'wire' && t.id === 'W1')).toBe(false)
    expect(tags.some(t => t.kind === 'trail' && t.id === 'T1')).toBe(false)
    const all = buildScene(b).prims.map(p => p.tag)
    expect(all.some(t => t.kind === 'part' && t.id === 'U1')).toBe(true)
    expect(all.some(t => t.kind === 'trail' && t.id === 'T1')).toBe(true)
    // Nothing goes missing for want of the hidden part.
    expect(buildScene(drawnBoard(b, hidden)).skipped).toEqual(buildScene(b).skipped)
  })
})

describe('itemsAtFinding: what a finding points at', () => {
  const b = board2()
  it('the items on its holes, or named in its message', () => {
    const t = b.trails[0]!
    const keys = itemsAtFinding(b, { holes: [t.points[0]!], message: 'x' })
    expect(keys).toContain(`trail:${t.id}`)
    expect(itemsAtFinding(b, { holes: [], message: 'U1 pin 3 is not soldered' })).toEqual(['part:U1'])
    expect(itemsAtFinding(b, { holes: [], message: 'U10 is not a part' })).toEqual([])
  })
})

describe('itemLit: the panel hover lights the item alone', () => {
  const b = board2()
  it('a trail, a wire, a part with its leads', () => {
    expect([...itemLit(b, 'trail:T1')!.ids]).toEqual(['trail:T1'])
    expect([...itemLit(b, 'wire:W1')!.ids]).toEqual(['wire:W1'])
    const u1 = itemLit(b, 'part:U1')!.ids
    expect(u1.has('part:U1')).toBe(true)
    expect(u1.has('lead:U1.1')).toBe(true)
    expect(itemLit(b, 'trail:T404')).toBeNull()
  })
})

describe('itemNets: the panel hover in 3D lights the item\'s nets', () => {
  const b = board2()
  const conn = buildConnectivity(b)
  it('a conductor\'s group nets; a part\'s pin nets', () => {
    const gi = conn.groups.findIndex(g => g.conductors.some(c => c.kind === 'trail' && c.id === 'T1'))
    expect(itemNets(conn, 'trail:T1')).toEqual(conn.groups[gi]!.nets)
    const u1 = placePart(b.parts.find(p => p.ref === 'U1')!)
    const want = new Set(u1.pins.flatMap(p => conn.groups[conn.groupOfLead.get(`U1.${p.name}`)!]?.nets ?? []))
    expect(new Set(itemNets(conn, 'part:U1'))).toEqual(want)
    expect(itemNets(conn, 'wire:W404')).toEqual([])
  })
})

describe('editTarget: no edits on what is hidden', () => {
  const b = board2()
  const t = b.trails.find(x => x.id === 'T1')!
  it('names the hidden trail an erase or a joint would change, else null', () => {
    const items = boardItems(b).trail.find(i => i.id === t.id)!
    const [h0, h1] = items.holes as [typeof items.holes[0], typeof items.holes[0]]
    expect(editTarget(b, new Set([`trail:${t.id}`]), t.side, h0, h1)).toBe(t.id)
    expect(editTarget(b, new Set(), t.side, h0, h1)).toBeNull()
    expect(editTarget(b, new Set([`trail:${t.id}`]), t.side, h1)).toBe(t.id)
  })
})

describe('hidden ids in storage', () => {
  it('one key per board, in the app\'s style', () => {
    expect(HIDDEN_PREFIX).toBe('wirebender:hidden:')
    expect(hiddenKey('abc')).toBe('wirebender:hidden:abc')
  })
  it('round-trips { hidden: string[] }', () => {
    const s = memStorage()
    expect(saveHidden('b1', ['trail:T1', 'part:U1'], () => s)).toBe(true)
    expect(JSON.parse(s.map.get('wirebender:hidden:b1')!)).toEqual({ hidden: ['trail:T1', 'part:U1'] })
    expect(loadHidden('b1', () => s)).toEqual(['trail:T1', 'part:U1'])
    expect(loadHidden('b2', () => s)).toEqual([])
  })
  it('malformed values mean nothing hidden; bad entries are dropped', () => {
    for (const raw of [null, '', 'not json', '42', '[]', '{"hidden":"x"}', 'null'])
      expect(parseHidden(raw), String(raw)).toEqual([])
    expect(parseHidden('{"hidden":["trail:T1",7,null,"trail:T1","part:U1"]}')).toEqual(['trail:T1', 'part:U1'])
  })
  it('an unavailable storage means nothing is hidden', () => {
    expect(loadHidden('b1', () => throwing)).toEqual([])
    expect(loadHidden('b1', () => null)).toEqual([])
    expect(loadHidden('b1', () => {
      throw new Error('localStorage is blocked')
    })).toEqual([])
    expect(saveHidden('b1', ['trail:T1'], () => throwing)).toBe(false)
    expect(saveHidden('b1', ['trail:T1'], () => undefined)).toBe(false)
  })
})
