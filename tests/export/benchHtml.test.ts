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
    const cards = (html.match(/<section class="card"/g) ?? []).length
    expect(cards).toBe(benchModel(board2()).cards.length)
    expect(bars).toBeGreaterThanOrEqual(1 + cards)
    // each card carries its own scale bar
    for (const sec of html.split('<section class="card"').slice(1))
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
})
