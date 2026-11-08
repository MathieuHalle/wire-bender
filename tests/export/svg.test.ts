import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { wireCards, type WireCard } from '~core/bench/cards'
import { parseBoard, type BoardFile } from '~core/schema'
import { bendSvgs, boardOverviewSvg, legFoldSvg, scaleBarSvg, stripBarSvg } from '../../export/svg'
import { mk, trail } from '../core/helpers'

function board2(): BoardFile {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/channel-board-2.json', import.meta.url)), 'utf8'))
  const res = parseBoard(raw)
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const laid = (id: string, points: string[], bareSegments: number[] = []) =>
  ({ id, kind: 'laid' as const, side: 'bottom' as const, points, bareSegments, joints: [] })

/** width/height in mm and the matching viewBox. */
function mmBox(svg: string): { w: number, h: number } {
  const m = /^<svg[^>]*\bwidth="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  expect(m, svg.slice(0, 200)).not.toBeNull()
  expect(Number(m![3])).toBeCloseTo(Number(m![1]), 6)
  expect(Number(m![4])).toBeCloseTo(Number(m![2]), 6)
  return { w: Number(m![1]), h: Number(m![2]) }
}

/** Lines of an svg with an attribute matching `attr`, as lengths in mm (with their attrs). */
function lines(svg: string, attr: RegExp) {
  return [...svg.matchAll(/<line ([^>]*)\/>/g)].map(m => m[1]!).filter(a => attr.test(a)).map((a) => {
    const v = (k: string) => Number(new RegExp(`\\b${k}="([-\\d.]+)"`).exec(a)![1])
    return { a, x1: v('x1'), y1: v('y1'), x2: v('x2'), y2: v('y2'), len: Math.hypot(v('x2') - v('x1'), v('y2') - v('y1')) }
  })
}
/** Total drawn wire in a set of row svgs: the path pieces plus both dashed lead stubs. */
const drawnMm = (svgs: string[]) =>
  svgs.flatMap(s => lines(s, /data-(piece|lead)=/)).reduce((a, l) => a + l.len, 0)

/** The svg's text content, whitespace collapsed (a label may run over two lines). */
const words = (svg: string) => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('bendSvgs leads', () => {
  const tr = () => wireCards(mk({ board: { cols: 20, rows: 20 }, trails: [trail('T1', ['A1', 'A10', 'F10'])] }))[0]!
  const lw = () => wireCards(mk({ board: { cols: 30, rows: 20 }, wires: [laid('W1', ['A1', 'A10', 'F10', 'F20'], [2])] }))[0]!

  it('draws a dashed start lead and an end lead + spare; total = cut minus bend allowances', () => {
    for (const c of [tr(), lw()]) {
      const svgs = bendSvgs(c)
      expect(drawnMm(svgs)).toBeCloseTo(c.cutMm - c.breakdown.bendsMm, 2)
      const all = svgs.join('')
      const start = lines(all, /data-lead="start"/)
      const end = lines(all, /data-lead="end"/)
      expect(start).toHaveLength(1)
      expect(end).toHaveLength(1)
      expect(start[0]!.a).toContain('stroke-dasharray')
      expect(end[0]!.a).toContain('stroke-dasharray')
      expect(start[0]!.len).toBeCloseTo(c.breakdown.leadsMm / 2, 6)
      expect(end[0]!.len).toBeCloseTo(c.cutMm - c.breakdown.bendsMm - c.breakdown.pathMm - c.breakdown.leadsMm / 2, 6)
      expect(words(all)).toContain('lead: bend down into the hole')
    }
    expect(words(bendSvgs(lw()).join(''))).toContain('lead + spare: trim after soldering')
    expect(words(bendSvgs(tr()).join(''))).toContain('longer tail = spare, trim after soldering')
  })

  it('the start lead continues straight past the start hole, outward along the first segment', () => {
    const c = tr() // bottom side, mirrored: A1 -> A10 runs to the left in the drawing
    const svg = bendSvgs(c)[0]!
    const sx = Number(/<circle[^>]*data-role="start"[^>]*cx="([-\d.]+)" cy="([-\d.]+)"/.exec(svg)![1])
    const sy = Number(/<circle[^>]*data-role="start"[^>]*cx="([-\d.]+)" cy="([-\d.]+)"/.exec(svg)![2])
    const st = lines(svg, /data-lead="start"/)[0]!
    // one end on the start hole, the other 5 mm further right (away from A10), same y
    expect(st.x1).toBeCloseTo(sx, 3)
    expect(st.y1).toBeCloseTo(sy, 3)
    expect(st.x2 - sx).toBeCloseTo(5, 3)
    expect(st.y2).toBeCloseTo(sy, 3)
    const piece = lines(svg, /data-piece=/)[0]!
    expect(piece.x2).toBeLessThan(piece.x1) // first segment goes left, the lead goes right
  })

  it('split rows with leads still fit and still add up', () => {
    const [c] = wireCards(mk({ board: { cols: 90, rows: 30 }, wires: [laid('W1', ['A1', 'A80', 'U80'])] }))
    for (const max of [180, 150, 120]) {
      const svgs = bendSvgs(c!, max)
      expect(svgs.length).toBeGreaterThanOrEqual(2)
      for (const s of svgs) expect(mmBox(s).w).toBeLessThanOrEqual(max)
      expect(drawnMm(svgs)).toBeCloseTo(c!.cutMm - c!.breakdown.bendsMm, 2)
    }
    // a straight run that only just fits without its leads must split to keep them on the page
    const [d] = wireCards(mk({ board: { cols: 90, rows: 10 }, trails: [trail('T1', ['A1', 'A70'])] }))
    for (const s of bendSvgs(d!, 180)) expect(mmBox(s).w).toBeLessThanOrEqual(180)
    expect(drawnMm(bendSvgs(d!, 180))).toBeCloseTo(d!.cutMm, 2)
  })

  it('draws at the board pitch: 9 holes at 2.0 mm are 18 mm', () => {
    const [c] = wireCards(mk({ board: { cols: 20, rows: 20, type: 'two-sided', pitchMm: 2.0 }, trails: [trail('T1', ['A1', 'A10'], 'top')] }))
    const svg = bendSvgs(c!)[0]!
    const s = /<circle[^>]*data-role="start"[^>]*cx="([\d.]+)"/.exec(svg)!
    const e = /<circle[^>]*data-role="end"[^>]*cx="([\d.]+)"/.exec(svg)!
    expect(Number(e[1]) - Number(s[1])).toBeCloseTo(9 * 2.0, 3)
    expect(svg).toContain('18 mm')
  })
})

describe('bendSvgs', () => {
  it('bend drawing has mm units', () => {
    const [c] = wireCards(mk({ board: { cols: 20, rows: 20 }, trails: [trail('T1', ['A1', 'A10', 'F10'])] }))
    const svgs = bendSvgs(c!)
    expect(svgs).toHaveLength(1)
    mmBox(svgs[0]!)
    expect(svgs[0]).toContain('A1')
    expect(svgs[0]).toContain('F10')
    expect(svgs[0]).toContain('23 mm') // 9 holes = 22.86 mm, shown to 0.5 mm
    expect(svgs[0]).toContain('12.5 mm') // 5 holes = 12.7 mm
    expect(svgs[0]).toContain('90°')
    expect(svgs[0]).toContain('seen from the solder side (board turned over)')
  })

  it('top wires say parts side', () => {
    const [c] = wireCards(mk({ board: { cols: 20, rows: 20, type: 'two-sided' }, trails: [trail('T1', ['A1', 'A10', 'F10'], 'top')] }))
    expect(bendSvgs(c!)[0]).toContain('seen from the parts side')
  })

  it('long wire splits to fit the page', () => {
    // 79 + 20 holes = 251.5 mm, the first run alone is 200.7 mm wide.
    const [c] = wireCards(mk({ board: { cols: 90, rows: 30 }, wires: [laid('W1', ['A1', 'A80', 'U80'])] }))
    expect(c!.breakdown.pathMm).toBeGreaterThan(250)
    const svgs = bendSvgs(c!, 180)
    expect(svgs.length).toBeGreaterThanOrEqual(2)
    expect(svgs[0]).toContain('continues')
    expect(svgs[1]).toContain('continued')
    for (const s of svgs) expect(mmBox(s).w).toBeLessThanOrEqual(180)
  })

  it('splits at a bend when the rows fit', () => {
    // Two 150 mm runs joined by a U: the whole is 150 wide, so it fits; at 100 it splits at bends.
    const [c] = wireCards(mk({ board: { cols: 70, rows: 30 }, wires: [laid('W1', ['A1', 'A40', 'K40', 'K1'])] }))
    expect(bendSvgs(c!, 180)).toHaveLength(1)
    const rows = bendSvgs(c!, 120)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0]).toMatch(/continues ▸/)
    expect(rows[1]).toMatch(/◂ continued/)
  })

  it('bottom drawing is mirrored', () => {
    const [c] = wireCards(mk({ board: { cols: 20, rows: 20 }, trails: [trail('T1', ['A1', 'A10', 'F10'])] }))
    const svg = bendSvgs(c!)[0]!
    const { w } = mmBox(svg)
    const cx = Number(/<circle[^>]*data-role="start"[^>]*cx="([\d.]+)"/.exec(svg)![1])
    expect(cx).toBeGreaterThan(w * 0.6)
    // and on the top, the start stays on the left
    const [t] = wireCards(mk({ board: { cols: 20, rows: 20, type: 'two-sided' }, trails: [trail('T1', ['A1', 'A10', 'F10'], 'top')] }))
    const top = bendSvgs(t!)[0]!
    const tx = Number(/<circle[^>]*data-role="start"[^>]*cx="([\d.]+)"/.exec(top)![1])
    expect(tx).toBeLessThan(mmBox(top).w * 0.4)
  })

  it('segments are drawn at 1:1', () => {
    const [c] = wireCards(mk({ board: { cols: 20, rows: 20, type: 'two-sided' }, trails: [trail('T1', ['A1', 'A10'], 'top')] }))
    const svg = bendSvgs(c!)[0]!
    const s = /<circle[^>]*data-role="start"[^>]*cx="([\d.]+)"/.exec(svg)!
    const e = /<circle[^>]*data-role="end"[^>]*cx="([\d.]+)"/.exec(svg)!
    expect(Number(e[1]) - Number(s[1])).toBeCloseTo(9 * 2.54, 2)
  })

  it('flying wires have no bend drawing', () => {
    const b = mk({ wires: [{ id: 'W1', kind: 'flying', side: 'bottom', points: ['A1', 'C5'], bareSegments: [], joints: [] }] })
    expect(bendSvgs(wireCards(b)[0]!)).toEqual([])
  })

  it('escapes text', () => {
    const b = mk({
      board: { cols: 20, rows: 20 },
      nets: { 'A<&>"\'': {} },
      wires: [{ ...laid('W<1>', ['A1', 'A5']), color: '"><script>' }]
    })
    const svg = bendSvgs(wireCards(b)[0]!)[0]!
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('W<1>')
    expect(svg).toContain('W&lt;1&gt;')
  })
})

describe('boardOverviewSvg', () => {
  it('overview has every part ref', () => {
    const b = board2()
    expect(b.parts).toHaveLength(30)
    for (const side of ['top', 'bottom'] as const) {
      const svg = boardOverviewSvg(b, side)
      mmBox(svg)
      for (const p of b.parts) expect(svg).toContain(`>${p.ref}<`)
    }
  })

  it('bottom is mirrored: column 1 on the right', () => {
    const b = mk({ board: { cols: 20, rows: 10 }, trails: [trail('T1', ['A1', 'A3'])] })
    const bottom = boardOverviewSvg(b, 'bottom')
    const top = boardOverviewSvg(b, 'top')
    const col1 = (svg: string) => Number(/<text[^>]*data-col="1"[^>]*x="([\d.]+)"/.exec(svg)![1])
    expect(col1(bottom)).toBeGreaterThan(mmBox(bottom).w * 0.6)
    expect(col1(top)).toBeLessThan(mmBox(top).w * 0.4)
  })

  it('draws only the trails of its side', () => {
    const b = mk({ board: { cols: 20, rows: 10, type: 'two-sided' }, trails: [trail('T1', ['A1', 'A3'], 'top'), trail('T2', ['C1', 'C3'], 'bottom')] })
    expect(boardOverviewSvg(b, 'top')).toContain('data-trail="T1"')
    expect(boardOverviewSvg(b, 'top')).not.toContain('data-trail="T2"')
    expect(boardOverviewSvg(b, 'bottom')).toContain('data-trail="T2"')
  })
})

describe('boardOverviewSvg bottom flip', () => {
  const num = (a: string, k: string) => Number(new RegExp(`\\b${k}="([-\\d.]+)"`).exec(a)![1])
  /** The hole grid's circles, in draw order: row by row, column by column. */
  const holes = (svg: string) => [...svg.matchAll(/<circle ([^>]*fill="#ffffff"[^>]*)\/>/g)].map(m => ({ x: num(m[1]!, 'cx'), y: num(m[1]!, 'cy') }))
  const pathPts = (svg: string, attr: string) => {
    const d = new RegExp(`<path [^>]*${attr}[^>]*\\bd="([^"]+)"`).exec(svg)![1]!
    return [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]) }))
  }
  const cols = 20
  const rows = 10
  const b = mk({ board: { cols, rows }, trails: [trail('T1', ['A1', 'A3', 'C3'])] })
  const at = (svg: string, col: number, row: number) => holes(svg)[(row - 1) * cols + (col - 1)]!

  it('the default is the left-right mirror, unchanged from before the flip choice', () => {
    expect(boardOverviewSvg(b, 'bottom')).toBe(boardOverviewSvg(b, 'bottom', { flip: 'lr' }))
    // the fixture's drawings, byte for byte as they were before the flip choice existed
    const fx = board2()
    const h = (x: string) => createHash('sha256').update(x).digest('hex')
    expect(h(boardOverviewSvg(fx, 'top'))).toBe('c4041a0fff92e17a49f3691ba2e9429270fffb14e825e7e7c2b96bb19364f3c6')
    expect(h(boardOverviewSvg(fx, 'bottom'))).toBe('ca3bc9c3f08ac70d85382429d7628438e1d89f0e127a04e479ca9d546360add4')
    expect(h(boardOverviewSvg(fx, 'bottom', { title: false, labelSize: 1.2 }))).toBe('ac682f2ce898cf2a5f5629dde4eeaf68eeae1698dbdaf2081dc9b482c61069ef')
  })

  it('tb puts a trail at the top-bottom mirrored holes: A1 bottom left, columns not mirrored', () => {
    const svg = boardOverviewSvg(b, 'bottom', { flip: 'tb' })
    const a1 = at(svg, 1, 1)
    const all = holes(svg)
    expect(all).toHaveLength(cols * rows)
    // A1 is the leftmost hole of the lowest row
    expect(a1.y).toBeCloseTo(Math.max(...all.map(q => q.y)), 6)
    expect(a1.x).toBeCloseTo(Math.min(...all.map(q => q.x)), 6)
    // the last row is at the top, column 1 still on the left
    expect(at(svg, 1, rows).y).toBeCloseTo(Math.min(...all.map(q => q.y)), 6)
    expect(at(svg, 1, rows).y).toBeCloseTo(a1.y - (rows - 1) * 2.54, 3)
    // the trail runs over the same holes, A1 -> A3 -> C3, so C3 is above A1
    expect(pathPts(svg, 'data-trail="T1"')).toEqual([a1, at(svg, 3, 1), at(svg, 3, 3)])
    expect(at(svg, 3, 3).y).toBeLessThan(a1.y)
    // lr: the same trail with column 1 on the right, row A at the top
    const lr = boardOverviewSvg(b, 'bottom')
    expect(at(lr, 1, 1).x).toBeCloseTo(Math.max(...holes(lr).map(q => q.x)), 6)
    expect(at(lr, 1, 1).y).toBeCloseTo(Math.min(...holes(lr).map(q => q.y)), 6)
  })

  it('tb: row letters sit by their own (moved) row, column numbers by their own column', () => {
    const svg = boardOverviewSvg(b, 'bottom', { flip: 'tb' })
    const label = (t: string) => [...svg.matchAll(new RegExp(`<text ([^>]*)>${t}</text>`, 'g'))].map(m => ({ x: num(m[1]!, 'x'), y: num(m[1]!, 'y') }))
    for (const [letter, row] of [['A', 1], ['J', rows]] as const) {
      const ls = label(letter)
      expect(ls.length, letter).toBeGreaterThanOrEqual(2)
      for (const l of ls) expect(l.y - 0.8, letter).toBeCloseTo(at(svg, 1, row).y, 3)
    }
    const col1 = Number(/<text[^>]*data-col="1"[^>]*x="([\d.]+)"/.exec(svg)![1])
    expect(col1).toBeCloseTo(at(svg, 1, 1).x, 3)
  })

  it('tb leaves text upright, and the top side ignores the flip', () => {
    const svg = boardOverviewSvg(b, 'bottom', { flip: 'tb' })
    expect(svg).not.toMatch(/transform=|scale\(/)
    expect(boardOverviewSvg(b, 'top', { flip: 'tb' })).toBe(boardOverviewSvg(b, 'top'))
  })

  it('tb ghosts follow the flip', () => {
    const two = mk({
      board: { cols, rows, type: 'two-sided' },
      trails: [trail('T9', ['A2', 'A6', 'D6'], 'bottom')],
      wires: [{ id: 'W1', kind: 'laid', side: 'top', points: ['A2', 'A6', 'D6'], bareSegments: [], joints: [] }]
    })
    const svg = boardOverviewSvg(two, 'bottom', { flip: 'tb' })
    expect(pathPts(svg, 'data-ghost="W1"')).toEqual(pathPts(svg, 'data-trail="T9"'))
  })
})

describe('boardOverviewSvg ghost wires', () => {
  const wire = (id: string, kind: 'laid' | 'flying', side: 'top' | 'bottom', points: string[]) =>
    ({ id, kind, side, points, bareSegments: [], joints: [] })
  const ghosts = (svg: string) => [...svg.matchAll(/<path ([^>]*data-ghost="([^"]+)"[^>]*)\/>/g)].map(m => ({ a: m[1]!, id: m[2]! }))
  const d = (a: string) => /\bd="([^"]+)"/.exec(a)![1]!
  // a bottom trail along the same holes as the top wire W1: the bottom's own geometry
  const b = mk({
    board: { cols: 20, rows: 10, type: 'two-sided' },
    trails: [trail('T9', ['A2', 'A6', 'D6'], 'bottom')],
    wires: [
      wire('W1', 'laid', 'top', ['A2', 'A6', 'D6']),
      wire('W2', 'flying', 'top', ['B2', 'C3', 'F9']),
      wire('W3', 'laid', 'bottom', ['H1', 'H4'])
    ]
  })

  it('a top-side wire is dashed in the bottom overview, mirrored like the bottom\'s own copper', () => {
    const svg = boardOverviewSvg(b, 'bottom')
    const g = ghosts(svg)
    expect(g.map(x => x.id)).toEqual(['W1', 'W2'])
    const w1 = g[0]!.a
    expect(w1).toContain('stroke-dasharray="0.7 0.45"')
    expect(w1).toContain('fill="none"')
    expect(w1).toContain('stroke-opacity="0.6"')
    const trailD = d(/<path ([^>]*data-trail="T9"[^>]*)\/>/.exec(svg)![1]!)
    expect(d(w1)).toBe(trailD)
    // the flying wire: one straight piece between its ends
    expect(d(g[1]!.a).match(/[ML]/g)).toEqual(['M', 'L'])
    // the top overview draws W1 as a wire, not a ghost, and ghosts the bottom W3
    expect(ghosts(boardOverviewSvg(b, 'top')).map(x => x.id)).toEqual(['W3'])
  })

  it('ghosts are drawn under the side\'s own copper and wires', () => {
    const svg = boardOverviewSvg(b, 'bottom')
    const lastGhost = svg.lastIndexOf('data-ghost=')
    expect(lastGhost).toBeGreaterThan(-1)
    expect(lastGhost).toBeLessThan(svg.indexOf('data-trail='))
    expect(lastGhost).toBeLessThan(svg.indexOf('data-wire='))
  })

  it('no wires on the other side: no ghost elements', () => {
    const one = mk({ board: { cols: 20, rows: 10 }, wires: [wire('W3', 'laid', 'bottom', ['H1', 'H4'])] })
    expect(boardOverviewSvg(one, 'bottom')).not.toContain('data-ghost')
    expect(boardOverviewSvg(one, 'top')).toContain('data-ghost="W3"')
    expect(boardOverviewSvg(mk({ board: { cols: 20, rows: 10 } }), 'top')).not.toContain('data-ghost')
  })
})

describe('stripBarSvg', () => {
  const w5: WireCard = {
    id: 'W5', kind: 'flying', side: 'bottom', net: 'GND', netClass: 'GND', color: null, pitchMm: 2.54,
    start: 'X17', end: 'X9', segments: [], bends: [],
    breakdown: { pathMm: 80, bendsMm: 0, leadsMm: 10, spareMm: 5, slackMm: 10 },
    cutMm: 105,
    strip: [{ fromStartMm: 5, toBare: false }, { fromStartMm: 100, toBare: true }],
    stretches: [{ lengthMm: 5, bare: true }, { lengthMm: 95, bare: false }, { lengthMm: 5, bare: true }]
  }

  it('strip bar labels', () => {
    const svg = stripBarSvg(w5, 150)
    expect(svg).toContain('strip at 5 mm')
    expect(svg).toContain('strip at 100 mm')
    expect(svg).toContain('95 mm')
    expect(svg).toContain('✂')
    expect(mmBox(svg).w).toBeCloseTo(150, 6)
  })

  it('rounds strip marks to 0.5 mm', () => {
    const svg = stripBarSvg({ ...w5, strip: [{ fromStartMm: 5.26, toBare: false }, { fromStartMm: 99.74, toBare: true }] }, 150)
    expect(svg).toContain('strip at 5.5 mm')
    expect(svg).toContain('strip at 99.5 mm')
  })
})

describe('scaleBarSvg', () => {
  it('scale bar is exactly 10 mm', () => {
    const svg = scaleBarSvg()
    mmBox(svg)
    const m = /<line[^>]*x1="([\d.]+)"[^>]*x2="([\d.]+)"/.exec(svg)!
    expect(Number(m[2]) - Number(m[1])).toBeCloseTo(10, 9)
    expect(svg).toContain('10 mm — measure to check print scale')
  })
})

describe('legFoldSvg', () => {
  it('sketches the fold with both hole names', () => {
    const svg = legFoldSvg({ lead: 'DA1.b', from: 'M2', to: 'M1', note: 'fold DA1.b (M2) flat toward M1, solder both' }, 2.54)
    mmBox(svg)
    expect(svg).toContain('>M2<')
    expect(svg).toContain('>M1<')
    expect(svg).toContain('DA1.b')
    expect(svg).toContain('solder side')
  })
})

describe('pitch', () => {
  it('export/svg.ts has no hard-coded 2.54 pitch', () => {
    const src = readFileSync(fileURLToPath(new URL('../../export/svg.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/2\.54/)
  })

  it('the leg-fold sketch is drawn at 3x the given pitch', () => {
    const row = { lead: 'R1.a', from: 'A1', to: 'A2', note: '' }
    const pads = (svg: string) => [...svg.matchAll(/<circle [^>]*stroke="#b87333"[^>]*cx="([-\d.]+)"/g)].map(m => Number(m[1]))
    const xs = pads(legFoldSvg(row, 2.0))
    expect(Math.abs(xs[1]! - xs[0]!)).toBeCloseTo(6, 6)
  })
})
