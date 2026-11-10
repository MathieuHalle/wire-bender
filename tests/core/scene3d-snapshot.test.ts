import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../core/schema'
import { buildScene } from '../../core/scene3d'

// The existing parts must not change as the parts library grows: channel board 2 (relays,
// TO-220s, DIP-8, terminals, a header, polyfuses, axials, a disc cap) renders the same prims.
describe('channel board 2 in 3D', () => {
  it('renders the same prims as before the parts library', async () => {
    const raw = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8'))
    const parsed = parseBoard(raw)
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    const scene = buildScene(parsed.board)
    await expect(JSON.stringify({ prims: scene.prims, bounds: scene.bounds, skipped: scene.skipped }, null, 1))
      .toMatchFileSnapshot('./__snapshots__/channel-board-2.scene3d.json')
  })
})
