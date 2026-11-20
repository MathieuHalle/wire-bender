// The code review of the strips work (2026-11-20): each test is one of its failure scenarios.
import { describe, expect, it } from 'vitest'
import { runCheck } from '~core/check'
import { buildConnectivity } from '~core/connectivity'
import { jumperClick, toggleCut } from '~core/edit'
import { parseHole } from '~core/holes'
import { parseBoard } from '~core/schema'
import { breadboard400, mk } from './helpers'

const H = parseHole
const header = (ref: string, at: string, net: string | null) => ({ ref, footprint: 'header-1x1', at, rotation: 0 as const, pins: { 1: net } })
const strips = { strips: [{ from: 'C1', to: 'C10' }, { from: 'D1', to: 'D10' }] }
const rule = (b: ReturnType<typeof mk>, r: string) => runCheck(b).findings.filter(f => f.rule === r)

describe('a cutout across a strip takes its copper', () => {
  const b = mk({ board: { ...strips, cutouts: [{ kind: 'grid', from: 'C5', to: 'D6' }] }, parts: [header('X', 'C2', 'A'), header('Y', 'C9', 'B')] })
  it('splits the strip: no short, no cut proposal', () => {
    const c = buildConnectivity(b)
    expect(c.groupOfLead.get('X.1')).not.toBe(c.groupOfLead.get('Y.1'))
    expect(rule(b, 'short')).toEqual([])
    expect(rule(b, 'cutProposal')).toEqual([])
  })
  it('refuses a cut in a hole the cutout took', () => {
    expect(toggleCut(b, H('C5'))).toEqual({ ok: false, reason: 'Hole C5 is off the board.' })
    const raw = JSON.parse(JSON.stringify(b))
    raw.cuts = ['C5']
    const r = parseBoard(raw)
    expect(r.ok ? [] : r.errors).toEqual(['cuts[0]: C5 is not on the board (an opening took it)'])
  })
})

describe('strips on a shaped board', () => {
  it('refuses a strip through a hole the shape removed', () => {
    const r = parseBoard({ ...mk(), board: { ...mk().board, shape: { kind: 'round' }, strips: [{ from: 'A1', to: 'A10' }] } })
    expect(r.ok ? [] : r.errors).toEqual(['board.strips[0]: A1 is off the board\'s shape'])
  })
})

describe('a bad grid cutout name', () => {
  it('is an error list, never a throw, even on a round board', () => {
    const r = parseBoard({ ...mk(), board: { ...mk().board, shape: { kind: 'round' }, cutouts: [{ kind: 'grid', from: 'a1', to: 'B2' }] } })
    expect(r.ok).toBe(false)
    expect(r.ok ? [] : r.errors).toContain('board.cutouts[0].from: bad hole name: a1')
  })
})

describe('a jumper takes its id when the wire is made', () => {
  it('another wire added between the two clicks keeps its id', () => {
    const b = mk({ board: breadboard400() })
    const first = jumperClick(b, H('D3'), null)
    if (!first.ok) throw new Error(first.reason)
    const other = { ...b, wires: [{ id: 'W1', kind: 'laid' as const, side: 'top' as const, points: ['K20', 'K24'], bareSegments: [], joints: [] }] }
    const second = jumperClick(other, H('D9'), first.drawing)
    expect(second.ok && second.board.wires.map(w => w.id)).toEqual(['W1', 'W2'])
    expect(second.ok && parseBoard(second.board).ok).toBe(true)
  })
})

describe('cut rules, finer', () => {
  it('a double cut between two nets is needed: no idleCut', () => {
    const b = mk({ board: strips, parts: [header('A', 'C2', 'X'), header('B', 'C9', 'Y')], cuts: ['C5', 'C6'] })
    expect(rule(b, 'idleCut')).toEqual([])
  })
  it('never proposes a cut where a bottom wire is soldered', () => {
    const b = mk({
      board: strips, parts: [header('A', 'C2', 'X'), header('B', 'C4', 'Y')],
      wires: [{ id: 'W1', kind: 'laid', side: 'bottom', points: ['C3', 'F3'], bareSegments: [], joints: [] }]
    })
    expect(rule(b, 'cutProposal')[0]!.message).toContain('with no free hole between them')
  })
  it('warns of a trail soldered in a cut hole', () => {
    const b = mk({ board: strips, trails: [{ id: 'T1', side: 'bottom', points: ['C5', 'F5'], joints: [] }], cuts: ['C5'] })
    expect(rule(b, 'onCut').map(f => f.message)).toEqual(['In a cut hole: trail T1 at C5, where the copper is cut away: there is nothing to solder it to'])
  })
})
