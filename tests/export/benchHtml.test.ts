import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ADVISORY } from '~core/advisory'
import { benchModel } from '~core/bench/sheet'
import { parseBoard, type BoardFile } from '~core/schema'
import { benchHtml } from '../../export/benchHtml'
import { axial, mk, trail } from '../core/helpers'

function board2(): BoardFile {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/channel-board-2.json', import.meta.url)), 'utf8'))
  const res = parseBoard(raw)
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

const DATE = '2026-01-02'

const small = () => mk({
  name: 'tiny <b>&',
  nets: { N: {} },
  parts: [axial('R1', 'A1', 'A4', 'N'), axial('R2', 'C1', 'C4', 'N')],
  trails: [trail('T1', ['A1', 'C1'])]
})

/** Visible text of the document, tags, scripts and styles dropped. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('benchHtml', () => {
  const html = benchHtml(board2(), { date: DATE })

  it('document is self-contained', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<link\b/i)
    const srcs = [...html.matchAll(/\bsrc\s*=\s*["']?([^"'\s>]*)/gi)].map(m => m[1]!)
    expect(srcs.every(s => s.startsWith('data:'))).toBe(true)
    expect(html).not.toMatch(/@import|url\(/)
  })

  it('errors are shown first', () => {
    const open = mk({ nets: { N: {} }, parts: [axial('R1', 'A1', 'A4', 'N'), axial('R2', 'C1', 'C4', 'N')] })
    const m = benchModel(open)
    expect(m.check.errors.length).toBeGreaterThan(0)
    const out = benchHtml(open, { date: DATE })
    const box = out.indexOf('class="errors"')
    expect(box).toBeGreaterThan(0)
    expect(box).toBeLessThan(out.indexOf('id="overview"'))
    const n = m.check.errors.length
    expect(out).toContain(`This board has ${n} error${n === 1 ? '' : 's'} — fix them before building`)
    for (const f of m.check.errors) expect(out).toContain(f.message.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    // a clean board has no error box
    expect(benchHtml(small(), { date: DATE })).not.toContain('class="errors"')
  })

  it('every 1:1 page has a scale bar', () => {
    const ov = html.slice(html.indexOf('<section id="overview"'))
    expect(ov.slice(0, ov.indexOf('</section>'))).toContain('aria-label="scale bar, 10 mm"')
    const bars = (html.match(/aria-label="scale bar, 10 mm"/g) ?? []).length
    const cards = (html.match(/<section class="card[ "]/g) ?? []).length
    expect(cards).toBe(benchModel(board2()).cards.length)
    expect(bars).toBeGreaterThanOrEqual(1 + cards)
    // each card carries its own scale bar
    for (const sec of html.split(/<section class="card[ "]/).slice(1))
      expect(sec.slice(0, sec.indexOf('</section>'))).toContain('aria-label="scale bar, 10 mm"')
  })

  it('advisory is the last text', () => {
    expect(text(html).endsWith(ADVISORY)).toBe(true)
    expect(text(benchHtml(small(), { date: DATE })).endsWith(ADVISORY)).toBe(true)
  })

  it('paper a4 switches @page', () => {
    expect(html).toMatch(/@page\s*\{\s*size:\s*letter;\s*margin:\s*12mm/)
    const b = board2()
    const a4 = benchHtml({ ...b, bench: { ...b.bench, paper: 'a4' } }, { date: DATE })
    expect(a4).toMatch(/@page\s*\{\s*size:\s*A4;\s*margin:\s*12mm/)
    expect(a4).not.toMatch(/size:\s*letter/)
  })

  it('ticks use localStorage in try/catch', () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!)
    expect(scripts).toHaveLength(1)
    const js = scripts[0]!
    // every localStorage access sits inside a try block
    const tries = [...js.matchAll(/try\s*\{([^}]*)\}\s*catch/g)].map(m => m[1]!)
    const inTry = tries.join('\n').match(/localStorage/g)?.length ?? 0
    expect(inTry).toBeGreaterThan(0)
    expect(js.match(/localStorage/g)?.length).toBe(inTry)
    expect(html).toContain('Clear ticks')
    expect(html).toMatch(/<input type="checkbox" data-tick="[^"]+"/)
    // tick ids are unique
    const ids = [...html.matchAll(/data-tick="([^"]+)"/g)].map(m => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the storage key uses the hash when given, else the revision', () => {
    const b = board2()
    expect(benchHtml(b, { date: DATE })).toContain(JSON.stringify(`wirebender:${b.name}:${b.revision}`).replace(/</g, '\\u003c'))
    expect(benchHtml(b, { hash: 'abc123', date: DATE })).toContain(`wirebender:${b.name}:abc123`)
  })

  it('escapes the board name and all sections are present in order', () => {
    const out = benchHtml(small(), { date: DATE })
    expect(out).not.toContain('tiny <b>')
    expect(out).toContain('tiny &lt;b&gt;&amp;')
    const ids = ['header', 'overview', 'placement', 'cards', 'legfolds', 'meter'].map(id => out.indexOf(`id="${id}"`))
    expect(ids.every(i => i > 0)).toBe(true)
    expect([...ids].sort((a, b) => a - b)).toEqual(ids)
  })

  it('cards show the cut length, breakdown and bend drawing or "no bends"', () => {
    const m = benchModel(board2())
    const c = m.cards.find(x => x.kind === 'trail')!
    expect(html).toContain(`Cut ${c.cutMm} mm`)
    const straight = benchHtml(small(), { date: DATE })
    expect(straight).toContain('no bends')
  })

  it('no fixed content wider than the printable width', () => {
    const widths = [...html.matchAll(/<svg width="([\d.]+)mm"/g)].map(m => Number(m[1]))
    expect(Math.max(...widths)).toBeLessThanOrEqual(191.9)
  })

  it('uses the given date, defaults to today', () => {
    expect(html).toContain('generated 2026-01-02')
    expect(benchHtml(small())).toMatch(/generated \d{4}-\d{2}-\d{2}/)
  })

  it('cards wider than a print column span both columns', () => {
    const b = mk({ board: { cols: 60, rows: 10 }, trails: [trail('T1', ['A1', 'A50']), trail('T2', ['C1', 'C5'])] })
    const out = benchHtml(b, { date: DATE })
    expect(out).toContain('<section class="card wide" id="card-T1">')
    expect(out).toContain('<section class="card" id="card-T2">')
    expect(out).toMatch(/\.columns \.card\.wide \{ column-span: all; \}/)
  })

  it('meter tables name the probes A and B', () => {
    expect(html).toContain('<th>Probe A</th><th>Probe B</th>')
  })

  it('escapes hostile strings from the board file', () => {
    const evil = '<img src=x onerror=1>'
    const b = mk({
      name: evil,
      nets: { [evil]: { class: evil }, N2: {} },
      netClasses: { [evil]: {} },
      parts: [
        { ...axial('R1', 'A1', 'A4', evil, 'N2'), label: evil, value: evil },
        axial('R2', 'C1', 'C4', evil, 'N2')
      ],
      trails: [trail('T1', ['A1', 'C1'])],
      wires: [{ id: evil, kind: 'laid', side: 'bottom', points: ['A4', 'C4'], bareSegments: [], joints: [] }],
      legFolds: [{ lead: 'R1.a', to: 'B1' }]
    })
    const out = benchHtml(b, { date: DATE })
    expect(out).not.toMatch(/<img/i)
    expect(out).toContain('&lt;img src=x onerror=1&gt;')
    // every src= is escaped text: HTML-escaped in the page, \u003c-escaped in the script's storage key
    const before = [...out.matchAll(/\bsrc\s*=/gi)].map(m => out.slice(m.index - 10, m.index))
    expect(before.length).toBeGreaterThan(0)
    expect(before.every(p => p.endsWith('&lt;img ') || p.endsWith('\\u003cimg '))).toBe(true)
  })

  it('per-card scale bar check sees wide cards too', () => {
    expect(html.split(/<section class="card[ "]/).length - 1).toBe(benchModel(board2()).cards.length)
  })

  describe('wide boards', () => {
    const wide = (paper: 'letter' | 'a4') => {
      const b = mk({
        board: { cols: 90, rows: 30 },
        nets: { N: {} },
        parts: [axial('R1', 'A1', 'A4', 'N'), axial('R2', 'C80', 'C84', 'N')],
        trails: [trail('T1', ['A1', 'A70', 'C70', 'C80']), trail('T2', ['E1', 'E5'])],
        wires: [{ id: 'W1', kind: 'laid', side: 'bottom', points: ['G1', 'G88', 'P88'], bareSegments: [1], joints: [] }],
        legFolds: [{ lead: 'R1.b', to: 'A5' }]
      })
      return benchHtml({ ...b, bench: { ...b.bench, paper } }, { date: DATE })
    }
    const PRINTABLE = { letter: 191.9, a4: 186 }

    it('an overview wider than the page is fitted and says so; every 1:1 svg fits the page', () => {
      for (const paper of ['letter', 'a4'] as const) {
        const out = wide(paper)
        expect(out).toContain('Overview not to scale (board wider than the page). Wire cards are 1:1.')
        const fitted = [...out.matchAll(/<div class="drawing fitted">(<svg[\s\S]*?<\/svg>)<\/div>/g)]
        expect(fitted).toHaveLength(2)
        for (const f of fitted) expect(Number(/^<svg width="([\d.]+)mm"/.exec(f[1]!)![1])).toBeGreaterThan(PRINTABLE[paper])
        // no 1:1 scale bar claims the fitted overview
        const ov = out.slice(out.indexOf('<section id="overview"'))
        expect(ov.slice(0, ov.indexOf('</section>'))).not.toContain('aria-label="scale bar, 10 mm"')
        const rest = out.replace(/<div class="drawing fitted">[\s\S]*?<\/svg><\/div>/g, '')
        const widths = [...rest.matchAll(/<svg width="([\d.]+)mm"/g)].map(m => Number(m[1]))
        expect(widths.length).toBeGreaterThan(5)
        for (const w of widths) expect(w).toBeLessThanOrEqual(PRINTABLE[paper])
      }
    })

    it('fitted overviews shrink with CSS; print containers clip', () => {
      const out = wide('letter')
      expect(out).toMatch(/\.drawing\.fitted svg \{[^}]*max-width: 100%;[^}]*height: auto;/)
      expect(out).toMatch(/@media print \{[\s\S]*\.drawing, \.scale, \.strip, \.sketch[^{]*\{ overflow: hidden; \}/)
    })

    it('a board that fits keeps its 1:1 overview', () => {
      expect(html).not.toContain('Overview not to scale')
      expect(html).not.toContain('class="drawing fitted"')
    })
  })

  it('the card hint says to lay the wire from the dashed start', () => {
    expect(html).toContain('Lay the cut wire on the drawing from the dashed start; bend at each marked corner.')
  })

  it('cards name the material in words', () => {
    const b = mk({
      board: { cols: 20, rows: 10 },
      trails: [trail('T1', ['A1', 'A5'])],
      wires: [
        { id: 'W1', kind: 'laid', side: 'bottom', points: ['C1', 'C5'], bareSegments: [], joints: [], color: 'black' },
        { id: 'W2', kind: 'flying', side: 'bottom', points: ['E1', 'G5'], bareSegments: [], joints: [] }
      ]
    })
    const out = benchHtml(b, { date: DATE })
    const sec = (id: string) => {
      const s = out.slice(out.indexOf(`id="card-${id}"`))
      return s.slice(0, s.indexOf('</section>'))
    }
    expect(sec('T1')).toContain('bare tinned copper')
    expect(sec('W1')).toContain('insulated wire, black')
    expect(sec('W2')).toContain('insulated wire, any colour')
    // spare tail note under the strip bar of wires
    expect(sec('W1')).toMatch(/<div class="strip">[\s\S]*<\/div>\n<p class="hint">longer tail = spare, trim after soldering<\/p>/)
    expect(sec('W2')).toContain('longer tail = spare, trim after soldering')
  })

  it('the cut length has no float noise', () => {
    const b = small()
    const out = benchHtml({ ...b, bench: { ...b.bench, roundToMm: 0.1 } }, { date: DATE })
    // A1 -> C1: 5.08 + 10 + 5 = 20.08 -> 20.1
    expect(out).toContain('Cut 20.1 mm')
    expect(out).toContain('rounded up to 0.1 mm: 20.1 mm')
    expect(out).not.toMatch(/\d\.\d{6,}/)
  })

  it('an empty net name reads "(unnamed net)"', () => {
    const b = mk({
      nets: { '': {} },
      parts: [axial('R1', 'A1', 'A4', ''), axial('R2', 'C1', 'C4', '')],
      trails: [trail('T1', ['A1', 'C1'])]
    })
    const out = benchHtml(b, { date: DATE })
    const card = out.slice(out.indexOf('id="card-T1"'))
    expect(card.slice(0, card.indexOf('</section>'))).toContain('(unnamed net)')
    expect(out).toContain('<tr class="group"><th colspan="5">(unnamed net)</th></tr>')
    expect(out).toContain('(unnamed net) continuous')
  })

  it('says how many nets were left out of must-beep because they are shorted', () => {
    const b = mk({
      parts: [axial('R1', 'A1', 'A4', 'p', 'q'), axial('R2', 'C1', 'C4', 'q', 'p')],
      trails: [trail('T1', ['A1', 'C1'], 'bottom', ['A1', 'C1']), trail('T2', ['A4', 'C4'], 'bottom', ['A4', 'C4'])]
    })
    expect(benchHtml(b, { date: DATE })).toContain('2 nets left out of this list: they are shorted (see the errors at the top).')
    expect(benchHtml(small(), { date: DATE })).not.toContain('left out of this list')
  })
})
