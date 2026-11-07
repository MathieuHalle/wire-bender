import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { parseBoard, type BoardFile } from '../../core/schema'
import { openDb, type Db } from '../../server/db'
import * as api from '../../server/utils/api'
import { MAX_BOARD_BYTES } from '../../server/utils/api'
import { getBoard, listBoards, listRevisions } from '../../server/utils/boards'
import { openRoom } from '../../server/utils/rooms'
import { docToBoard, writeBoard } from '../../shared/yboard'

let dir: string
let db: Db
const text = readFileSync(path.resolve(__dirname, '../fixtures/channel-board-2.json'), 'utf8')
const fixture = JSON.parse(text) as BoardFile

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-api-'))
  db = openDb(dir)
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function importFixture(): string {
  const r = api.createOrImport(db, JSON.stringify({ board: fixture }))
  expect(r.status).toBe(200)
  return (r.body as { id: string }).id
}

describe('create and import', () => {
  it('import then get returns the board with head 1', () => {
    const id = importFixture()
    const r = api.getBoardResponse(db, id)
    expect(r.status).toBe(200)
    const body = r.body as { id: string, name: string, head: number, board: BoardFile }
    expect(body).toMatchObject({ id, name: 'Channel board 2', head: 1 })
    expect(body.board.revision).toBe(1)
    expect(body.board.parts).toEqual(fixture.parts)
  })

  it('creates an empty board that parses', () => {
    const r = api.createOrImport(db, JSON.stringify({ name: 'Blank', cols: 10, rows: 8, type: 'two-sided' }))
    expect(r.status).toBe(200)
    const id = (r.body as { id: string }).id
    const got = api.getBoardResponse(db, id).body as { board: BoardFile }
    expect(got.board).toMatchObject({ name: 'Blank', board: { cols: 10, rows: 8, pitchMm: 2.54, type: 'two-sided' }, parts: [] })
    expect(parseBoard(got.board).ok).toBe(true)
    expect(listRevisions(db, id)[0]).toMatchObject({ how: 'create', author: 'Local' })
  })

  it('rejects a bad create with 422', () => {
    for (const body of [{ name: '', cols: 4, rows: 4, type: 'one-sided' }, { name: 'x', cols: 0, rows: 4, type: 'one-sided' }, { name: 'x', cols: 4, rows: 4, type: 'round' }, {}]) {
      const r = api.createOrImport(db, JSON.stringify(body))
      expect(r.status).toBe(422)
      expect((r.body as { errors: string[] }).errors.length).toBeGreaterThan(0)
    }
    expect(listBoards(db)).toEqual([])
  })

  it('bad import creates nothing', () => {
    expect(api.createOrImport(db, '{ nope').status).toBe(422)
    const schema = api.createOrImport(db, JSON.stringify({ board: { name: 'x' } }))
    expect(schema.status).toBe(422)
    expect((schema.body as { errors: string[] }).errors.length).toBeGreaterThan(0)
    expect(api.createOrImport(db, 'x'.repeat(MAX_BOARD_BYTES + 1)).status).toBe(413)
    expect(listBoards(db)).toEqual([])
  })
})

describe('put', () => {
  it('with a stale baseRevision is 409 and changes nothing', () => {
    const id = importFixture()
    const r = api.putBoard(db, id, JSON.stringify({ board: { ...fixture, name: 'Other' }, baseRevision: 0 }))
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ current: 1 })
    expect(listRevisions(db, id)).toHaveLength(1)
    expect((api.getBoardResponse(db, id).body as { name: string }).name).toBe('Channel board 2')
  })

  it('with a stale baseRevision on a room with no peers drops the room', () => {
    const id = importFixture()
    const room = openRoom(db, id)!
    expect(api.putBoard(db, id, JSON.stringify({ board: fixture, baseRevision: 0 })).status).toBe(409)
    expect(openRoom(db, id)).not.toBe(room)
    openRoom(db, id)!.leave('nobody')
  })

  it('PUT with base = head during an open group is 409, and the tablet edit survives', () => {
    vi.useFakeTimers()
    try {
      const id = importFixture()
      const claudeView = getBoard(db, id)!
      const room = openRoom(db, id)!
      const doc = new Y.Doc()
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc), 'remote')
      room.join('tablet', 'Tablet', { update: u => Y.applyUpdate(doc, u, 'remote'), awareness: () => {} })
      doc.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin !== 'remote') expect(room.receive('tablet', 'Tablet', u)).toEqual({ ok: true })
      })
      const before = docToBoard(doc, 0)
      if (!before.ok) throw new Error(before.errors.join())
      writeBoard(doc, before.board, { ...before.board, name: 'tablet rename' })

      const r = api.putBoard(db, id, JSON.stringify({ board: claudeView.board, baseRevision: claudeView.head }), 'Claude')
      expect(r).toEqual({ status: 409, body: { current: 2 } })
      expect(getBoard(db, id)!.board.name).toBe('tablet rename')
      expect(listRevisions(db, id).map(x => [x.n, x.how, x.author])).toEqual([[2, 'edit', 'Tablet'], [1, 'import', 'Local']])
      expect(api.putBoard(db, id, JSON.stringify({ board: { ...claudeView.board, name: 'Claude' }, baseRevision: 2 }), 'Claude').status).toBe(200)
      room.leave('tablet')
      doc.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('without baseRevision writes a revision how api', () => {
    const id = importFixture()
    const r = api.putBoard(db, id, JSON.stringify({ board: { ...fixture, name: 'Other' } }))
    expect(r).toEqual({ status: 200, body: { revision: 2 } })
    expect(listRevisions(db, id)[0]).toMatchObject({ n: 2, how: 'api', author: 'Local' })
    expect(api.putBoard(db, id, JSON.stringify({ board: fixture, baseRevision: 2 })).status).toBe(200)
  })

  it('is 422 for an invalid board and 404 for an unknown one', () => {
    const id = importFixture()
    expect(api.putBoard(db, id, JSON.stringify({ board: { name: 'x' } })).status).toBe(422)
    expect(api.putBoard(db, id, JSON.stringify({ board: fixture, baseRevision: 'one' })).status).toBe(422)
    expect(api.putBoard(db, 'nope', JSON.stringify({ board: fixture })).status).toBe(404)
    expect(api.putBoard(db, id, 'x'.repeat(MAX_BOARD_BYTES + 1)).status).toBe(413)
    expect(listRevisions(db, id)).toHaveLength(1)
  })
})

describe('rename', () => {
  it('is a board change by Local through the API', () => {
    const id = importFixture()
    expect(api.renameBoard(db, id, JSON.stringify({ name: '  New name ' })).body).toEqual({ revision: 2 })
    expect((api.getBoardResponse(db, id).body as { name: string }).name).toBe('New name')
    expect(listRevisions(db, id)[0]).toMatchObject({ how: 'api', author: 'Local' })
    expect(api.renameBoard(db, id, JSON.stringify({ name: '   ' })).status).toBe(422)
    expect(api.renameBoard(db, id, JSON.stringify({ name: 3 })).status).toBe(422)
    expect(api.renameBoard(db, 'nope', JSON.stringify({ name: 'a' })).status).toBe(404)
  })
})

describe('revisions, restore, undo, redo', () => {
  it('lists revisions and returns one board', () => {
    const id = importFixture()
    api.putBoard(db, id, JSON.stringify({ board: { ...fixture, name: 'B' } }))
    const list = api.listRevisionsResponse(db, id).body as { n: number }[]
    expect(list.map(r => r.n)).toEqual([2, 1])
    expect((api.getRevisionResponse(db, id, '1').body as BoardFile).name).toBe('Channel board 2')
    expect(api.getRevisionResponse(db, id, '9').status).toBe(404)
    expect(api.getRevisionResponse(db, id, 'abc').status).toBe(404)
  })

  it('restore makes revision n the current board as a new revision', () => {
    const id = importFixture()
    api.putBoard(db, id, JSON.stringify({ board: { ...fixture, name: 'B' } }))
    const r = api.restoreRevision(db, id, '1')
    expect(r).toEqual({ status: 200, body: { revision: 3 } })
    const got = api.getBoardResponse(db, id).body as { name: string, head: number }
    expect(got).toMatchObject({ name: 'Channel board 2', head: 3 })
    expect(listRevisions(db, id)[0]).toMatchObject({ n: 3, how: 'restore', target: 1 })
    expect(api.restoreRevision(db, id, '9').status).toBe(404)
  })

  it('undo with nothing to undo is 409; undo and redo otherwise', () => {
    const id = importFixture()
    expect(api.undoBoard(db, id)).toEqual({ status: 409, body: { reason: 'nothing to undo' } })
    expect(api.redoBoard(db, id)).toEqual({ status: 409, body: { reason: 'nothing to redo' } })
    api.putBoard(db, id, JSON.stringify({ board: { ...fixture, name: 'B' } }))
    expect(api.undoBoard(db, id)).toEqual({ status: 200, body: { revision: 3 } })
    expect((api.getBoardResponse(db, id).body as { name: string }).name).toBe('Channel board 2')
    expect(api.redoBoard(db, id)).toEqual({ status: 200, body: { revision: 4 } })
    expect((api.getBoardResponse(db, id).body as { name: string }).name).toBe('B')
    expect(api.undoBoard(db, 'nope').status).toBe(404)
  })
})

describe('check, bench, download', () => {
  it('check returns findings, stats and the stats line', () => {
    const id = importFixture()
    const r = api.checkBoard(db, id)
    expect(r.status).toBe(200)
    const body = r.body as { findings: unknown[], stats: { errors: number }, statsLine: string, advisory: string }
    expect(Array.isArray(body.findings)).toBe(true)
    expect(body.statsLine).toMatch(/^\d+ nets?, \d+ groups?: \d+ errors?/)
    expect(body.advisory).toBe('Advisory only. Check the board with a meter before powering it.')
    expect(api.checkBoard(db, 'nope').status).toBe(404)
  })

  it('bench returns HTML containing the board name, keyed by id and head', () => {
    const id = importFixture()
    const r = api.benchBoard(db, id, '2026-11-06')
    expect(r.status).toBe(200)
    expect(r.headers?.['content-type']).toBe('text/html; charset=utf-8')
    expect(r.headers?.['content-disposition']).toBe('inline; filename="Channel-board-2.bench.html"')
    expect(r.body as string).toContain('Channel board 2')
    expect(r.body as string).toMatch(/wirebender:Channel board 2:[0-9a-f]{12}/)
    api.putBoard(db, id, JSON.stringify({ board: fixture }))
    const again = api.benchBoard(db, id, '2026-11-06').body as string
    expect(again).not.toBe(r.body)
    expect(api.benchBoard(db, 'nope').status).toBe(404)
  })

  it('download sets the filename and returns a board that parses', () => {
    const id = importFixture()
    const r = api.downloadBoard(db, id)
    expect(r.status).toBe(200)
    expect(r.headers?.['content-disposition']).toBe('attachment; filename="Channel-board-2.wirebender.json"')
    expect(parseBoard(JSON.parse(r.body as string)).ok).toBe(true)
    expect(api.downloadBoard(db, 'nope').status).toBe(404)
  })
})
