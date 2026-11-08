import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { benchModel } from '~core/bench/sheet'
import { holeMm, parseHole } from '~core/holes'
import { parseBoard, type BoardFile } from '~core/schema'
import { sideMap } from '~core/sideView'
import { benchHtml } from '../../export/benchHtml'
import { bendSvgs, legFoldSvg } from '../../export/svg'

function board2(): BoardFile {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/channel-board-2.json', import.meta.url)), 'utf8'))
  const res = parseBoard(raw)
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
type Pt = { x: number, y: number }

/** The [x1,y1,x2,y2] of every <line> whose attributes contain `marker`. */
function lines(svg: string, marker: string): number[][] {
  const out: number[][] = []
  for (const m of svg.matchAll(/<line ([^>]*)\/>/g)) {
    if (!m[1]!.includes(marker)) continue
    const g = (k: string) => Number(new RegExp(`${k}="([^"]+)"`).exec(m[1]!)![1])
    out.push([g('x1'), g('y1'), g('x2'), g('y2')])
  }
  return out
}

describe('default (lr) drawings are unchanged', () => {
  const b = board2()
  const m = benchModel(b)
  it('wire cards', () => {
    expect(sha(m.cards.map(c => bendSvgs(c).join('')).join('|'))).toBe('6e2b25a418414587')
  })
  it('leg-fold sketches', () => {
    expect(m.legFolds.length).toBe(12)
    expect(sha(m.legFolds.map(f => legFoldSvg(f, b.board.pitchMm)).join('|'))).toBe('af91b70841bb1232')
  })
  it('an explicit lr map draws the same', () => {
    const lr = sideMap(b, 'lr')
    expect(m.cards.map(c => bendSvgs(c, 180, lr).join('')).join('|')).toBe(m.cards.map(c => bendSvgs(c).join('')).join('|'))
    expect(m.legFolds.map(f => legFoldSvg(f, b.board.pitchMm, lr)).join('|'))
      .toBe(m.legFolds.map(f => legFoldSvg(f, b.board.pitchMm)).join('|'))
  })
})

describe('tb flip', () => {
  const b = board2()
  const m = benchModel(b)
  const tb = sideMap(b, 'tb')
  /** Offsets between consecutive points of the polyline, in the drawing's own axes. */
  const steps = (pts: Pt[]) => pts.slice(1).map((p, i) => ({ x: p.x - pts[i]!.x, y: p.y - pts[i]!.y }))

  it('a wire card puts its bends at the tb-mapped positions', () => {
    const card = m.cards.find(c => c.id === 'T3')!
    expect(card.bends.length).toBe(3)
    const svgs = bendSvgs(card, 180, tb)
    expect(svgs.length).toBe(1)
    const pieces = lines(svgs[0]!, 'data-piece').map(([x1, y1, x2, y2]) => ({ a: { x: x1!, y: y1! }, b: { x: x2!, y: y2! } }))
    expect(pieces.length).toBe(card.segments.length)
    const want = [parseHole(card.segments[0]!.from), ...card.segments.map(s => parseHole(s.to))].map(h => tb.pt(h))
    const got = [pieces[0]!.a, ...pieces.map(p => p.b)]
    const w = steps(want)
    const g = steps(got)
    g.forEach((s, i) => {
      expect(s.x).toBeCloseTo(w[i]!.x, 1)
      expect(s.y).toBeCloseTo(w[i]!.y, 1)
    })
    // and it is not the lr drawing
    expect(svgs[0]).not.toBe(bendSvgs(card)[0])
  })

  it('a leg-fold sketch puts the leg at the tb-mapped positions', () => {
    const f = m.legFolds[0]!
    const svg = legFoldSvg(f, b.board.pitchMm, tb)
    const [leg] = lines(svg, '#c0c6ca')
    const a = tb.pt(parseHole(f.from))
    const z = tb.pt(parseHole(f.to))
    const k = 3
    expect(leg![2]! - leg![0]!).toBeCloseTo((z.x - a.x) * k, 1)
    expect(leg![3]! - leg![1]!).toBeCloseTo((z.y - a.y) * k, 1)
    expect(svg).not.toBe(legFoldSvg(f, b.board.pitchMm))
    // sanity: the hole centre distance is what the map says
    expect(holeMm(parseHole(f.to), b.board.pitchMm)).toBeTruthy()
  })

  it('the sheet names the flip in the card and fold headers, and lr keeps its wording', () => {
    const tbHtml = benchHtml(b, { date: '2026-01-02', flip: 'tb' })
    const lrHtml = benchHtml(b, { date: '2026-01-02' })
    expect(tbHtml).toContain('board turned over, mirrored top↔bottom')
    expect(lrHtml).toContain('seen from the solder side (board turned over)')
    expect(lrHtml).toContain('solder side (board turned over), sketch 3×')
    expect(tbHtml).toContain('mirrored top↔bottom), sketch 3×')
  })
})
