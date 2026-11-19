import { describe, expect, it } from 'vitest'
import { runCheck } from '~core/check'
import { buildConnectivity } from '~core/connectivity'
import { parseBoard } from '~core/schema'
import { stripSegments } from '~core/strips'
import { toggleCut } from '~core/edit'
import { parseHole } from '~core/holes'
import { axial, breadboard400, mk } from './helpers'

const header = (ref: string, at: string, net: string | null) => ({ ref, footprint: 'header-1x1', at, rotation: 0 as const, pins: { 1: net } })
const strips = { strips: [{ from: 'B1', to: 'B10' }, { from: 'C1', to: 'C10' }] }
const rule = (b: ReturnType<typeof mk>, r: string) => runCheck(b).findings.filter(f => f.rule === r)
const raw = (over: Record<string, unknown>) => ({
  format: 'wirebender/1', revision: 0, name: 't',
  board: { cols: 10, rows: 10, pitchMm: 2.54, type: 'one-sided', blocked: [], ...strips },
  netClasses: {}, nets: {}, rules: { keepAway: [], adjacency: [] },
  parts: [], trails: [], wires: [], legFolds: [], solderBridges: [], ...over
})
const errs = (over: Record<string, unknown>) => {
  const r = parseBoard(raw(over))
  return r.ok ? [] : r.errors
}

describe('cuts in the format', () => {
  it('reads cuts on strip holes, and refuses others', () => {
    expect(errs({ cuts: ['B5'] })).toEqual([])
    expect(errs({ cuts: ['D5'] })).toEqual(['cuts[0]: D5 is not on a strip'])
    expect(errs({ cuts: ['B5', 'B5'] })).toEqual(['cuts[1]: duplicate B5'])
  })
})

describe('stripSegments', () => {
  it('splits a strip at its cuts, the cut hole in neither piece', () => {
    const b = mk({ board: strips, cuts: ['B4', 'B5', 'B10'] })
    expect(stripSegments(b.board, b.cuts).map(s => s.id)).toEqual(['B1-B3', 'B6-B9', 'C1-C10'])
  })
})

describe('connectivity with cuts', () => {
  it('a cut separates the two sides, and a lead in the cut hole joins nothing', () => {
    const b = mk({ board: strips, parts: [header('J1', 'B2', 'X'), header('J2', 'B8', 'X'), header('J3', 'B5', 'X')], cuts: ['B5'] })
    const c = buildConnectivity(b)
    const g = (l: string) => c.groupOfLead.get(l)
    expect(g('J1.1')).not.toBe(g('J2.1'))
    expect(c.groups[g('J3.1')!]!.conductors).toEqual([{ kind: 'lead', id: 'J3.1' }])
  })
})

describe('the cut rules', () => {
  it('proposes the free holes between two nets on a strip', () => {
    const b = mk({ board: strips, parts: [axial('R1', 'B2', 'B6', 'X', 'Y')] })
    const f = rule(b, 'cutProposal')
    expect(f.map(x => x.message)).toEqual(['Cut needed: strip B1–B10 joins X (R1.a at B2) and Y (R1.b at B6). Cut at one of B3, B4 or B5'])
    expect(f[0]!.holes).toEqual(['B3', 'B4', 'B5'])
  })
  it('proposes nothing once cut, and says when no hole is free', () => {
    expect(rule(mk({ board: strips, parts: [axial('R1', 'B2', 'B6', 'X', 'Y')], cuts: ['B4'] }), 'cutProposal')).toEqual([])
    const tight = mk({ board: strips, parts: [header('J1', 'B2', 'X'), header('J2', 'B3', 'Y')] })
    expect(rule(tight, 'cutProposal')[0]!.message).toBe('Cut needed: strip B1–B10 joins X (J1.1 at B2) and Y (J2.1 at B3), with no free hole between them to cut. Move one of the parts')
  })
  it('warns of a lead in a cut hole', () => {
    const b = mk({ board: strips, parts: [header('J1', 'B5', 'X')], cuts: ['B5'] })
    expect(rule(b, 'onCut').map(f => f.message)).toEqual(['In a cut hole: J1.1 at B5, where the copper is cut away: there is nothing to solder it to'])
  })
  it('notes a cut that separates nothing', () => {
    const same = mk({ board: strips, parts: [header('J1', 'B2', 'X'), header('J2', 'B8', 'X')], cuts: ['B5'] })
    expect(rule(same, 'idleCut').map(f => f.message)).toEqual(['Cut not needed: the cut at B5 has X on both sides'])
    const empty = mk({ board: strips, parts: [header('J1', 'B2', 'X')], cuts: ['B5'] })
    expect(rule(empty, 'idleCut').map(f => f.message)).toEqual(['Cut not needed: the cut at B5 has nothing connected on one side'])
    const needed = mk({ board: strips, parts: [header('J1', 'B2', 'X'), header('J2', 'B8', 'Y')], cuts: ['B5'] })
    expect(rule(needed, 'idleCut')).toEqual([])
  })
})

describe('toggleCut', () => {
  it('cuts a strip hole, and puts it back', () => {
    const b = mk({ board: strips })
    const r = toggleCut(b, parseHole('B5'))
    expect(r.ok && r.board.cuts).toEqual(['B5'])
    const back = r.ok ? toggleCut(r.board, parseHole('B5')) : r
    expect(back.ok && 'cuts' in back.board).toBe(false)
  })
  it('refuses a hole off the strips, and a breadboard', () => {
    expect(toggleCut(mk({ board: strips }), parseHole('D5'))).toEqual({ ok: false, reason: 'Hole D5 is not on a strip: there is nothing to cut.' })
    expect(toggleCut(mk({ board: breadboard400() }), parseHole('D5'))).toEqual({ ok: false, reason: 'A breadboard\'s clips can\'t be cut.' })
  })
})
