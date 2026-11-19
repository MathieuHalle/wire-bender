import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildConnectivity } from '~core/connectivity'
import { existingHoles } from '~core/boardShape'
import { holeName, parseHole } from '~core/holes'
import { parseBoard, type BoardFile } from '~core/schema'
import { axial, mk, trail } from './helpers'

const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const boards = (rel: string) => readdirSync(dir(rel)).filter(f => f.endsWith('.json')).map((f) => {
  const r = parseBoard(JSON.parse(readFileSync(`${dir(rel)}/${f}`, 'utf8')))
  return r.ok ? { name: f, board: r.board } : null
}).filter((x): x is { name: string, board: BoardFile } => x !== null)

/** Everything buildConnectivity answers, as plain data. */
function summary(board: BoardFile) {
  const c = buildConnectivity(board)
  const at = existingHoles(board.board).flatMap(h => (['bottom', 'top'] as const).map(s =>
    `${holeName(h)}/${s}:${c.groupAtHole(h, s)}:${c.netAtHole(h, s)}:${c.netsAtHole(h, s).join('+')}`))
  return { groups: c.groups, contacts: c.contacts, proposedJoints: c.proposedJoints, at }
}

// Focus 1: boards without strips connect exactly as before strips existed. Written before the
// strip code; any change here is a regression, not a snapshot to update.
describe('boards without strips', () => {
  for (const { name, board } of [...boards('../fixtures'), ...boards('../../docs/format/examples')])
    it(`${name} is unchanged`, () => {
      expect(summary(board)).toMatchSnapshot()
    })
})

const H = (n: string) => parseHole(n)
const header = (ref: string, at: string, net: string | null) => ({ ref, footprint: 'header-1x1', at, rotation: 0 as const, pins: { 1: net } })
const groupOf = (board: BoardFile, lead: string) => buildConnectivity(board).groupOfLead.get(lead)

describe('strips on a one-sided board (a stripboard)', () => {
  const strip = { strips: [{ from: 'B1', to: 'B10' }] }
  it('joins every lead on the strip, with nothing drawn', () => {
    const b = mk({ board: strip, parts: [axial('R1', 'B2', 'B6', null, null), header('J1', 'B9', null)] })
    const g = groupOf(b, 'R1.a')
    expect(groupOf(b, 'R1.b')).toBe(g)
    expect(groupOf(b, 'J1.1')).toBe(g)
    const conn = buildConnectivity(b)
    expect(conn.groups[g!]!.conductors).toContainEqual({ kind: 'strip', id: 'B1-B10' })
  })
  it('keeps a trail beside the strip apart from it', () => {
    const b = mk({ board: strip, parts: [header('J1', 'B9', 'X'), header('J2', 'C9', 'Y')], trails: [trail('T1', ['C1', 'C10'])] })
    expect(groupOf(b, 'J1.1')).not.toBe(groupOf(b, 'J2.1'))
  })
  it('reports a bare trail lying across a strip hole as a contact (Focus 2)', () => {
    const b = mk({ board: strip, trails: [trail('T1', ['A5', 'C5'])] })
    expect(buildConnectivity(b).contacts).toEqual([{ hole: H('B5'), side: 'bottom', trailId: 'T1', with: 'B1-B10', sameNet: true }])
  })
  it('lights the strip at an empty strip hole', () => {
    const b = mk({ board: strip, parts: [header('J1', 'B9', 'X')] })
    const conn = buildConnectivity(b)
    expect(conn.groupAtHole(H('B3'), 'bottom')).toBe(conn.groupOfLead.get('J1.1'))
    expect(conn.netAtHole(H('B3'), 'bottom')).toBe('X')
    expect(conn.groupAtHole(H('C3'), 'bottom')).toBeNull()
  })
})

describe('strips on a breadboard', () => {
  // Three clip strips, one per column.
  const board = {
    cols: 3, rows: 5, type: 'breadboard' as const, shape: { kind: 'strips' as const },
    strips: [{ from: 'A1', to: 'E1' }, { from: 'A2', to: 'E2' }, { from: 'A3', to: 'E3' }]
  }
  const jumper = { id: 'W1', kind: 'laid' as const, side: 'top' as const, points: ['A1', 'A2'], bareSegments: [], joints: [] }
  it('joins a lead and a jumper end in one clip strip, and the jumper joins two strips', () => {
    const b = mk({ board, parts: [header('J1', 'C1', 'X'), header('J2', 'D2', 'X'), header('J3', 'B3', 'Y')], wires: [jumper] })
    expect(groupOf(b, 'J1.1')).toBe(groupOf(b, 'J2.1'))
    expect(groupOf(b, 'J3.1')).not.toBe(groupOf(b, 'J1.1'))
    const conn = buildConnectivity(b)
    expect(conn.groupAtHole(H('E3'), 'bottom')).toBe(groupOf(b, 'J3.1'))
    expect(conn.contacts).toEqual([])
  })
})

describe('a rail with skipped holes', () => {
  it('joins its groups across the gaps', () => {
    const b = mk({ board: { cols: 12, rows: 1, shape: { kind: 'strips' }, strips: [{ from: 'A1', to: 'A11', skip: ['A6'] }] }, parts: [header('J1', 'A1', 'X'), header('J2', 'A11', 'X')] })
    expect(groupOf(b, 'J1.1')).toBe(groupOf(b, 'J2.1'))
  })
})
