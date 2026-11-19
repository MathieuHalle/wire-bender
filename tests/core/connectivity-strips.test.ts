import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildConnectivity } from '~core/connectivity'
import { existingHoles } from '~core/boardShape'
import { holeName } from '~core/holes'
import { parseBoard, type BoardFile } from '~core/schema'

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
