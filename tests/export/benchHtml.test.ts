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
  const html = benchHtml(board2())

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
    const out = benchHtml(open)
    const box = out.indexOf('class="errors"')
    expect(box).toBeGreaterThan(0)
    expect(box).toBeLessThan(out.indexOf('id="overview"'))
    const n = m.check.errors.length
    expect(out).toContain(`This board has ${n} error${n === 1 ? '' : 's'} — fix them before building`)
    for (const f of m.check.errors) expect(out).toContain(f.message.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    // a clean board has no error box
    expect(benchHtml(small())).not.toContain('class="errors"')
  })

  it('every 1:1 page has a scale bar', () => {
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
    expect(text(benchHtml(small())).endsWith(ADVISORY)).toBe(true)
  })

  it('paper a4 switches @page', () => {
    expect(html).toMatch(/@page\s*\{\s*size:\s*letter;\s*margin:\s*12mm/)
    const b = board2()
    const a4 = benchHtml({ ...b, bench: { ...b.bench, paper: 'a4' } })
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
    expect(benchHtml(b)).toContain(JSON.stringify(`wirebender:${b.name}:${b.revision}`).replace(/</g, '\\u003c'))
    expect(benchHtml(b, { hash: 'abc123' })).toContain(`wirebender:${b.name}:abc123`)
  })

  it('escapes the board name and all sections are present in order', () => {
    const out = benchHtml(small())
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
    const straight = benchHtml(small())
    expect(straight).toContain('no bends')
  })

  it('no fixed content wider than the printable width', () => {
    const widths = [...html.matchAll(/<svg width="([\d.]+)mm"/g)].map(m => Number(m[1]))
    expect(Math.max(...widths)).toBeLessThanOrEqual(191.9)
  })
})
