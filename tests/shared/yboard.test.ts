import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { parseBoard, type BoardFile } from '~core/schema'
import { boardToDoc, docToBoard, writeBoard } from '#shared/yboard'

function board2(): BoardFile {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/channel-board-2.json', import.meta.url)), 'utf8'))
  const res = parseBoard(raw)
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const load = (doc: Y.Doc): BoardFile => {
  const r = docToBoard(doc, 0)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.board
}
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
}
const pos = (doc: Y.Doc, section: string, key: string) =>
  (doc.getMap(section).get(key) as { pos: number }).pos

describe('Board <-> Yjs', () => {
  it('round trip keeps channel board 2', () => {
    const b = board2()
    const doc = new Y.Doc()
    boardToDoc(doc, b)
    const r = docToBoard(doc, 7)
    expect(r).toEqual({ ok: true, board: { ...b, revision: 7 } })
  })

  it('writeBoard writes only what changed', () => {
    const before = board2()
    const doc = new Y.Doc()
    boardToDoc(doc, before)
    const after = clone(before)
    after.wires.find(w => w.id === 'W5')!.side = 'top'
    const touched: string[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      for (const [type, keys] of tr.changed) {
        for (const k of keys) touched.push(`${[...doc.share.entries()].find(([, t]) => t === type)?.[0]}:${k}`)
      }
    })
    writeBoard(doc, before, after)
    expect(touched).toEqual(['wires:W5'])
    expect(load(doc)).toEqual(after)
  })

  it('writeBoard deletes removed items and adds new ones at the end', () => {
    const before = board2()
    const doc = new Y.Doc()
    boardToDoc(doc, before)
    const after = clone(before)
    const max = Math.max(...before.trails.map(t => pos(doc, 'trails', t.id)))
    after.trails.push({ id: 'T99', side: 'bottom', points: ['A1', 'A2'], joints: [] })
    const gone = after.parts.pop()!
    writeBoard(doc, before, after)
    expect(pos(doc, 'trails', 'T99')).toBe(max + 1)
    expect(doc.getMap('parts').has(gone.ref)).toBe(false)
    expect(load(doc)).toEqual(after)
  })

  it('does not resurrect an item a peer deleted when the local edit is elsewhere', () => {
    const b = board2()
    const a = new Y.Doc()
    boardToDoc(a, b)
    const c = new Y.Doc()
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a))
    const k = b.trails[1]!.id
    const ec = clone(b)
    ec.trails = ec.trails.filter(t => t.id !== k)
    writeBoard(c, b, ec)
    // The delete reaches A before A's own edit, which still sees K in its before/after.
    Y.applyUpdate(a, Y.encodeStateAsUpdate(c))
    const ea = clone(b)
    ea.trails[0]!.points = ['A9', 'B9']
    writeBoard(a, b, ea)
    sync(a, c)
    for (const d of [a, c]) {
      expect(d.getMap('trails').has(k)).toBe(false)
      expect(load(d).trails.some(t => t.id === k)).toBe(false)
    }
  })

  it('two docs editing different trails both land', () => {
    const b = board2()
    const a = new Y.Doc()
    boardToDoc(a, b)
    const c = new Y.Doc()
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a))
    const [t0, t1] = b.trails.map(t => t.id)
    const ea = clone(b)
    ea.trails.find(t => t.id === t0)!.points = ['A9', 'B9']
    const ec = clone(b)
    ec.trails.find(t => t.id === t1)!.points = ['A1', 'A2']
    writeBoard(a, b, ea)
    writeBoard(c, b, ec)
    sync(a, c)
    for (const d of [a, c]) {
      const r = load(d)
      expect(r.trails.find(t => t.id === t0)!.points).toEqual(['A9', 'B9'])
      expect(r.trails.find(t => t.id === t1)!.points).toEqual(['A1', 'A2'])
    }
  })

  it('two docs editing the same trail converge to one of the two', () => {
    const b = board2()
    const a = new Y.Doc()
    boardToDoc(a, b)
    const c = new Y.Doc()
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a))
    const id = b.trails[0]!.id
    const ea = clone(b)
    ea.trails[0]!.points = ['A1', 'A5']
    ea.trails[0]!.joints = ['A1']
    const ec = clone(b)
    ec.trails[0]!.points = ['B1', 'B2']
    writeBoard(a, b, ea)
    writeBoard(c, b, ec)
    sync(a, c)
    const ta = load(a).trails.find(t => t.id === id)
    const tc = load(c).trails.find(t => t.id === id)
    expect(ta).toEqual(tc)
    expect([ea.trails[0], ec.trails[0]]).toContainEqual(ta)
  })
})
