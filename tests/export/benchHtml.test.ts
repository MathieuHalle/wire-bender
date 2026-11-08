import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ADVISORY } from '~core/advisory'
import { benchModel } from '~core/bench/sheet'
import { parseBoard, type BoardFile } from '~core/schema'
import { benchHtml, enlargedArea } from '../../export/benchHtml'
import { boardOverviewSvg } from '../../export/svg'
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

  describe('section toggles panel', () => {
    const panelOf = (out: string) => out.match(/<aside id="sections-panel"[\s\S]*?<\/aside>/)?.[0] ?? ''
    const presentIds = (out: string) =>
      ['enlarged', 'overview', 'placement', 'cards', 'legfolds', 'meter'].filter(id => out.includes(`<section id="${id}"`))

    it('has one labelled checkbox per section present, plus All and None', () => {
      for (const out of [html, benchHtml(small(), { date: DATE })]) {
        const panel = panelOf(out)
        expect(panel).toContain('Sections')
        const boxes = [...panel.matchAll(/<input type="checkbox" data-section="([a-z]+)"/g)].map(m => m[1])
        expect(boxes.sort()).toEqual(presentIds(out).sort())
        for (const id of boxes) {
          const heading = out.match(new RegExp(`<section id="${id}"[^>]*>\\s*<h2>([^<]*)</h2>`))![1]!
          expect(panel).toMatch(new RegExp(`<label[^>]*><input type="checkbox" data-section="${id}"[^>]*> ${heading}</label>`))
        }
        expect(panel).toContain('>All</button>')
        expect(panel).toContain('>None</button>')
      }
    })

    it('names every section by its heading, in sheet order', () => {
      const labels = [...panelOf(html).matchAll(/data-section="[a-z]+"[^>]*> ([^<]*)<\/label>/g)].map(m => m[1])
      expect(labels).toEqual(['Board overview, 1:1', 'Both sides, enlarged', 'Parts placement', 'Wire cards', 'Leg-fold bridges', 'Meter tests'])
    })

    it('is hidden in print and starts hidden, so no-JS output is unchanged', () => {
      const print = html.slice(html.indexOf('@media print'))
      expect(print).toMatch(/#sections-panel\s*\{\s*display:\s*none/)
      expect(panelOf(html)).toMatch(/<aside id="sections-panel"[^>]* hidden/)
    })

    it('hidden sections vanish on screen and in print, without a page-break gap', () => {
      expect(html).toMatch(/\.section-off\s*\{\s*display:\s*none\s*!important/)
      expect(html).toMatch(/\.page\s*\{\s*break-before:\s*page/)
    })

    it('remembers the choice under the board key, every storage access in try/catch', () => {
      const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!)[0]!
      expect(js).toContain(':sections')
      expect(js).toContain('section-off')
    })

    it('the advisory sits outside every section, so no toggle can hide it', () => {
      for (const out of [html, benchHtml(small(), { date: DATE })]) {
        const footer = out.slice(out.indexOf('<footer>'))
        expect(footer).toContain(ADVISORY)
        const beforeFooter = out.slice(0, out.indexOf('<footer>'))
        expect((beforeFooter.match(/<section\b/g) ?? []).length).toBeGreaterThan(0)
        // the footer is not inside an open section
        expect((beforeFooter.match(/<section\b/g) ?? []).length).toBe((beforeFooter.match(/<\/section>/g) ?? []).length)
      }
    })
  })

  describe('enlarged page (both sides, filling a page)', () => {
    const sectionOf = (out: string, id: string) => {
      const s = out.slice(out.indexOf(`<section id="${id}"`))
      return s.slice(0, s.indexOf('</section>'))
    }
    /** The board drawings' printed sizes (the scale bar left out). */
    const sizes = (sec: string) => [...sec.matchAll(/<svg width="([\d.]+)mm" height="([\d.]+)mm"[^>]*aria-label="([^"]*)"/g)]
      .filter(m => !m[3]!.startsWith('scale bar')).map(m => ({ w: Number(m[1]), h: Number(m[2]) }))

    it('comes right after the 1:1 overview, on its own page, and says it is not to scale', () => {
      const ids = ['overview', 'enlarged', 'placement'].map(id => html.indexOf(`id="${id}"`))
      expect(ids.every(i => i > 0)).toBe(true)
      expect([...ids].sort((a, b) => a - b)).toEqual(ids)
      const sec = sectionOf(html, 'enlarged')
      expect(sec).toMatch(/^<section id="enlarged" class="page[ "]/)
      expect(text(sec)).toContain('not to scale')
      expect(sec).not.toContain('aria-label="scale bar, 10 mm"')
      expect(text(sec)).toContain('Top: parts side')
      expect(text(sec)).toContain('Bottom: solder side, seen from below (mirrored left↔right)')
    })

    it('draws both sides bigger than 1:1, keeping their shape, and fits the printable page', () => {
      for (const paper of ['letter', 'a4'] as const) {
        const b = board2()
        const out = benchHtml({ ...b, bench: { ...b.bench, paper } }, { date: DATE })
        // the 1:1 drawings without their in-drawing titles, as the enlarged page draws them
        const one = (['top', 'bottom'] as const).map((side) => {
          const m = /^<svg width="([\d.]+)mm" height="([\d.]+)mm"/.exec(boardOverviewSvg(b, side, { title: false }))!
          return { w: Number(m[1]), h: Number(m[2]) }
        })
        const big = sizes(sectionOf(out, 'enlarged'))
        expect(big).toHaveLength(2)
        const area = enlargedArea(paper)
        big.forEach((s, i) => {
          expect(s.w).toBeGreaterThan(one[i]!.w * 1.5)
          expect(s.w / s.h).toBeCloseTo(one[i]!.w / one[i]!.h, 2)
          expect(s.w).toBeLessThanOrEqual(area.w)
          expect(s.h).toBeLessThanOrEqual(area.h)
        })
        // side by side or stacked, the pair fits the page too
        const sideBySide = sectionOf(out, 'enlarged').includes('class="pair"')
        if (sideBySide) expect(big[0]!.w + big[1]!.w).toBeLessThanOrEqual(area.w)
        else expect(big[0]!.h + big[1]!.h).toBeLessThanOrEqual(area.h)
      }
    })

    it('never relies on landscape or named pages (Safari and Firefox ignore them)', () => {
      expect(html).not.toMatch(/landscape/)
      expect(html).not.toMatch(/\bpage:\s*\w/)
      expect(html).not.toMatch(/@page\s+\w/)
    })

    it('enlargedArea is the portrait printable area', () => {
      expect(enlargedArea('letter')).toEqual({ w: 215.9 - 24, h: 279.4 - 24 })
      expect(enlargedArea('a4')).toEqual({ w: 210 - 24, h: 297 - 24 })
    })

    it('the layout fits the portrait printable area, for channel board 2 and a wide board', () => {
      const wide = mk({ board: { cols: 60, rows: 20 }, nets: { N: {} }, parts: [axial('R1', 'A1', 'A4', 'N')] })
      for (const base of [board2(), wide]) {
        for (const paper of ['letter', 'a4'] as const) {
          const sec = sectionOf(benchHtml({ ...base, bench: { ...base.bench, paper } }, { date: DATE }), 'enlarged')
          const area = enlargedArea(paper)
          const [t, b] = sizes(sec)
          expect(t && b).toBeTruthy()
          if (sec.includes('class="pair"')) {
            expect(t!.w + b!.w + 6).toBeLessThanOrEqual(area.w + 0.01)
            expect(Math.max(t!.h, b!.h)).toBeLessThanOrEqual(area.h)
          } else {
            expect(Math.max(t!.w, b!.w)).toBeLessThanOrEqual(area.w)
            expect(t!.h + b!.h).toBeLessThanOrEqual(area.h)
          }
        }
      }
    })

    it('print keeps the drawings inside the page width, without distorting them', () => {
      const print = html.slice(html.indexOf('@media print'))
      expect(print).toMatch(/\.enlarged \.drawing svg\s*\{\s*max-width:\s*100%;\s*height:\s*auto/)
    })

    it('labels on the board print really small, so they do not hide the pads', () => {
      const sec = sectionOf(html, 'enlarged')
      const k = Number(/Enlarged (\d+)%/.exec(sec)![1]) / 100
      // part refs (bold) and trail / wire ids (brown) sit over the holes
      const labels = [...sec.matchAll(/<text ([^>]*)>/g)].map(m => m[1]!)
        .filter(a => a.includes('font-weight="600"') || a.includes('fill="#7a3f12"'))
      expect(labels.length).toBeGreaterThan(30)
      for (const a of labels) {
        expect(Number(/font-size="([\d.]+)"/.exec(a)![1]) * k).toBeLessThanOrEqual(1.65)
        expect(Number(/stroke-width="([\d.]+)"/.exec(a)![1]) * k).toBeLessThanOrEqual(0.45)
      }
      // the 1:1 overview keeps its readable labels
      const ov = sectionOf(html, 'overview')
      expect(ov).toMatch(/font-size="2.2"[^>]*font-weight="600"|font-weight="600"[^>]*font-size="2.2"/)
    })

    it('a board wider than tall is stacked, one side above the other', () => {
      const b = mk({ board: { cols: 40, rows: 10 }, nets: { N: {} }, parts: [axial('R1', 'A1', 'A4', 'N')] })
      const sec = sectionOf(benchHtml(b, { date: DATE }), 'enlarged')
      expect(sec).toContain('class="stack"')
    })
  })

  it('cards show the cut length, breakdown and bend drawing or "no bends"', () => {
    const m = benchModel(board2())
    const c = m.cards.find(x => x.kind === 'trail')!
    expect(html).toContain(`Cut ${c.cutMm} mm`)
    const straight = benchHtml(small(), { date: DATE })
    expect(straight).toContain('no bends')
  })

  it('no fixed content wider than the printable width', () => {
    // the enlarged page is checked against its own page (it may turn landscape)
    const portrait = html.replace(/<section id="enlarged"[\s\S]*?<\/section>/, '')
    const widths = [...portrait.matchAll(/<svg width="([\d.]+)mm"/g)].map(m => Number(m[1]))
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
        // the enlarged page is checked against its own page (it may turn landscape)
        const rest = out.replace(/<div class="drawing fitted">[\s\S]*?<\/svg><\/div>/g, '')
          .replace(/<section id="enlarged"[\s\S]*?<\/section>/, '')
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

describe('benchHtml bottom flip', () => {
  const sectionOf = (out: string, id: string) => {
    const s = out.slice(out.indexOf(`<section id="${id}"`))
    return s.slice(0, s.indexOf('</section>'))
  }
  const LR = 'Bottom: solder side, seen from below (mirrored left↔right)'
  const TB = 'Bottom: solder side, seen from below (mirrored top↔bottom)'

  it('the default is left-right: the same sheet as flip lr, as before the flip choice but for the caption', () => {
    const b = board2()
    const out = benchHtml(b, { hash: 'abc', date: '2026-11-07' })
    expect(out).toBe(benchHtml(b, { hash: 'abc', date: '2026-11-07', flip: 'lr' }))
    // byte for byte the sheet from before the flip choice, its caption '(mirrored)' now saying which flip
    expect(createHash('sha256').update(out).digest('hex')).toBe('77610ee00c24699cf9065673512891c7d0a827d7bd6879a549200dde37d37663')
    for (const id of ['overview', 'enlarged']) {
      expect(text(sectionOf(out, id)), id).toContain(LR)
      expect(text(sectionOf(out, id)), id).not.toContain('top↔bottom')
    }
  })

  it('tb: the 1:1 overview and the enlarged page draw the bottom flipped top-bottom and say so', () => {
    const b = board2()
    const out = benchHtml(b, { date: DATE, flip: 'tb' })
    for (const id of ['overview', 'enlarged']) {
      const sec = sectionOf(out, id)
      expect(text(sec), id).toContain(TB)
      expect(text(sec), id).not.toContain('left↔right')
    }
    expect(sectionOf(out, 'overview')).toContain(boardOverviewSvg(b, 'bottom', { flip: 'tb' }))
    expect(sectionOf(out, 'overview')).not.toContain(boardOverviewSvg(b, 'bottom'))
    // the top drawing is the same either way
    expect(sectionOf(out, 'overview')).toContain(boardOverviewSvg(b, 'top'))
  })
})
