// The bench sheet as one self-contained HTML file: print it (1:1 drawings) or open it on a
// phone at the bench and tick things off. Pure: board in, string out. The only script is the
// tick store (localStorage, every access in try/catch).
import { ADVISORY } from '../core/advisory'
import { benchModel, type BenchModel, type MeterRow } from '../core/bench/sheet'
import { netLabel, type WireCard } from '../core/bench/cards'
import type { BoardFile, Side } from '../core/schema'
import {
  bendSvgs, boardOverviewSvg, COPPER, esc, INSULATED_FALLBACK, legFoldSvg, mmExact, mmText, safeColor, scaleBarSvg,
  SPARE_TAIL_LABEL, stripBarSvg
} from './svg'

/** Printable width in mm: paper width minus two 12 mm margins. */
const PRINTABLE_MM = { letter: 215.9 - 24, a4: 210 - 24 } as const
/** Printable height in mm: paper height minus two 12 mm margins. */
const PRINTABLE_H_MM = { letter: 279.4 - 24, a4: 297 - 24 } as const
/** Gap between the two overviews when side by side, mm. */
const OVERVIEW_GAP_MM = 6
/** Room on the enlarged page for its heading and note, and for each caption, mm. */
const ENLARGED_HEAD_MM = 22
const CAPTION_MM = 8
/** Printed size of the part refs and trail / wire ids on the enlarged page, mm: small, so the pads stay visible. */
const ENLARGED_LABEL_MM = 1.5
/** Printable area of a page, mm, portrait or turned to landscape. */
export function enlargedArea(paper: keyof typeof PRINTABLE_MM, landscape: boolean): { w: number, h: number } {
  const [w, h] = [PRINTABLE_MM[paper], PRINTABLE_H_MM[paper]]
  return landscape ? { w: h, h: w } : { w, h }
}
/** Card border plus padding on both sides, mm: what a 1:1 drawing loses inside a card. */
const CARD_INSET_MM = 10
/** Gap between the two printed columns of cards and meter rows, mm. */
const COLUMN_GAP_MM = 5

const PAPER_LABEL = { letter: 'Letter', a4: 'A4' } as const

const svgWidthMm = (svg: string) => Number(/^<svg width="([\d.]+)mm"/.exec(svg)?.[1] ?? 0)
const svgHeightMm = (svg: string) => Number(/^<svg width="[\d.]+mm" height="([\d.]+)mm"/.exec(svg)?.[1] ?? 0)
/** The same drawing printed `k` times bigger: only its printed size changes, not its viewBox. */
const scaleSvg = (svg: string, k: number) => svg.replace(/^<svg width="([\d.]+)mm" height="([\d.]+)mm"/,
  (_, w, h) => `<svg width="${(Number(w) * k).toFixed(2)}mm" height="${(Number(h) * k).toFixed(2)}mm"`)
const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`

/** Unique, stable tick ids: the content key, with a suffix only when it repeats. */
function tickIds() {
  const used = new Map<string, number>()
  return (key: string) => {
    const k = used.get(key) ?? 0
    used.set(key, k + 1)
    return k === 0 ? key : `${key}#${k + 1}`
  }
}

const tick = (id: string, label = '') =>
  `<label class="tick"><input type="checkbox" data-tick="${esc(id)}">${label ? `<span>${esc(label)}</span>` : '<span class="sr">done</span>'}</label>`

const scaleBar = () => `<div class="scale">${scaleBarSvg()}</div>`

// ---- sections ------------------------------------------------------------------------

function header(m: BenchModel, date: string): string {
  const errs = m.check.errors
  const box = errs.length
    ? `<div class="errors" role="alert"><p><strong>This board has ${plural(errs.length, 'error')} — fix them before building</strong></p>`
    + `<ul>${errs.map(f => `<li>${esc(f.message)}</li>`).join('')}</ul></div>`
    : ''
  const s = m.check.stats
  return `<header id="header">
<h1>${esc(m.name)}</h1>
<p class="meta">Revision ${m.revision} · generated ${esc(date)} · ${PAPER_LABEL[m.paper]} paper · `
+ `${plural(s.errors, 'error')}, ${plural(s.warnings, 'warning')}, ${plural(s.cautions, 'caution')}</p>
<p class="screen-only"><button type="button" id="clear-ticks">Clear ticks</button></p>
${box}
</header>`
}

export const OVERVIEW_FITTED_NOTE = 'Overview not to scale (board wider than the page). Wire cards are 1:1.'

/**
 * Page 2: both sides as big as one page allows, side by side or one above the other,
 * whichever draws them bigger. For reading at the bench, so not to scale: no scale bar.
 */
function enlarged(board: BoardFile, paper: keyof typeof PRINTABLE_MM): string {
  // No in-drawing title: the captions name the sides, and the title would widen the drawing.
  const top = boardOverviewSvg(board, 'top', { title: false })
  const bottom = boardOverviewSvg(board, 'bottom', { title: false })
  const [w1, h1, w2, h2] = [svgWidthMm(top), svgHeightMm(top), svgWidthMm(bottom), svgHeightMm(bottom)]
  // Every layout this page can take: side by side or stacked, on a portrait or a landscape page.
  const layouts = [false, true].flatMap((landscape) => {
    const { w: W, h: Hp } = enlargedArea(paper, landscape)
    const H = Hp - ENLARGED_HEAD_MM
    return [
      { landscape, pair: true, k: Math.min((W - OVERVIEW_GAP_MM) / (w1 + w2), (H - CAPTION_MM) / Math.max(h1, h2)) },
      { landscape, pair: false, k: Math.min(W / Math.max(w1, w2), (H - 2 * CAPTION_MM - OVERVIEW_GAP_MM) / (h1 + h2)) }
    ]
  })
  // The biggest drawing wins; on a tie, portrait (like the other pages) and side by side.
  const best = layouts.reduce((a, b) => (b.k > a.k + 1e-9 ? b : a))
  const k = Math.floor(best.k * 100) / 100
  // Redrawn with small labels: they only shrink the drawing a little, so it still fits at k.
  const labelSize = ENLARGED_LABEL_MM / k
  const small = (side: Side) => boardOverviewSvg(board, side, { title: false, labelSize })
  const fig = (svg: string, caption: string) =>
    `<figure><figcaption>${caption}</figcaption><div class="drawing">${scaleSvg(svg, k)}</div></figure>`
  return `<section id="enlarged" class="page enlarged${best.landscape ? ' landscape' : ''}">
<h2>Both sides, enlarged</h2>
<p class="fitted-note"><strong>Enlarged ${Math.round(k * 100)}%, not to scale: measure on the 1:1 overview or the wire cards.</strong></p>
<div class="${best.pair ? 'pair' : 'stack'}">
${fig(small('top'), 'Top: parts side')}
${fig(small('bottom'), 'Bottom: solder side, seen from below (mirrored)')}
</div>
</section>`
}

function overview(board: BoardFile, printable: number): string {
  const top = boardOverviewSvg(board, 'top')
  const bottom = boardOverviewSvg(board, 'bottom')
  const sideBySide = svgWidthMm(top) + OVERVIEW_GAP_MM + svgWidthMm(bottom) <= printable
  // A board wider than the page would make the browser shrink every printed page; instead
  // the overviews alone are scaled down to fit (CSS), say so, and carry no scale bar.
  const fitted = Math.max(svgWidthMm(top), svgWidthMm(bottom)) > printable
  const fig = (svg: string, caption: string) =>
    `<figure><figcaption>${caption}</figcaption><div class="drawing${fitted ? ' fitted' : ''}">${svg}</div></figure>`
  return `<section id="overview" class="overview">
<h2>${fitted ? 'Board overview' : 'Board overview, 1:1'}</h2>
${fitted ? `<p class="fitted-note"><strong>${esc(OVERVIEW_FITTED_NOTE)}</strong></p>` : scaleBar()}
<div class="${sideBySide ? 'pair' : 'stack'}">
${fig(top, 'Top: parts side')}
${fig(bottom, 'Bottom: solder side, seen from below (mirrored)')}
</div>
</section>`
}

/**
 * A table whose cells carry their column name, so it can stack on a phone. A string row is a
 * group heading spanning every column.
 */
function table(cols: string[], rows: (string[] | string)[], cls = ''): string {
  const head = `<thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
  const body = rows.map(r => typeof r === 'string'
    ? `<tr class="group"><th colspan="${cols.length}">${esc(r)}</th></tr>`
    : `<tr>${r.map((cell, i) => `<td data-label="${esc(cols[i] ?? '')}">${cell}</td>`).join('')}</tr>`).join('\n')
  return `<table${cls ? ` class="${cls}"` : ''}>${head}<tbody>\n${body}\n</tbody></table>`
}

function placement(m: BenchModel, id: (k: string) => string): string {
  const rows = m.placement.map(p => [
    tick(id(`place:${p.ref}`)),
    String(p.step),
    `<strong>${esc(p.ref)}</strong>`,
    esc(p.name),
    esc(p.value ?? ''),
    `<span class="mono">${esc(p.holes)}</span>`,
    esc(p.orientation),
    esc(p.mounting)
  ])
  return `<section id="placement" class="page">
<h2>Parts placement</h2>
<p class="hint">Lowest parts first. Holes are pin:hole.</p>
${m.placement.length ? table(['Done', 'Step', 'Ref', 'Part', 'Value', 'Holes', 'Orientation', 'Mounting'], rows) : '<p>No parts.</p>'}
</section>`
}

const KIND_LABEL = { trail: 'trail', laid: 'laid wire', flying: 'flying wire' } as const
const SIDE_LABEL = { top: 'top (parts side)', bottom: 'bottom (solder side)' } as const

function breakdownLine(c: WireCard, roundTo: number): string {
  const b = c.breakdown
  const parts = [`path ${mmText(b.pathMm)}`]
  if (b.bendsMm > 0) parts.push(`${plural(c.bends.length, 'bend')} ${mmText(b.bendsMm)}`)
  parts.push(`leads ${mmText(b.leadsMm)}`, `spare ${mmText(b.spareMm)}`)
  if (b.slackMm > 0) parts.push(`slack ${mmText(b.slackMm)}`)
  const sum = b.pathMm + b.bendsMm + b.leadsMm + b.spareMm + b.slackMm
  return `${parts.join(' + ')} = ${mmText(sum)}, rounded up to ${mmExact(roundTo)}: ${mmExact(c.cutMm)}`
}

/** The wire to use, in words, so it survives black-and-white printing. */
function material(c: WireCard): string {
  return c.kind === 'trail' ? 'bare tinned copper' : `insulated wire, ${c.color ?? 'any colour'}`
}

function card(c: WireCard, board: BoardFile, printable: number, id: (k: string) => string): string {
  const color = c.kind === 'trail' ? COPPER : safeColor(c.color, INSULATED_FALLBACK)
  const net = c.net === null
    ? 'no net'
    : `${esc(netLabel(c.net))}${c.netClass ? ` <span class="muted">(${esc(c.netClass)})</span>` : ''}`
  const showStrip = c.strip.length > 0 || c.kind !== 'trail'
  // In print, cards sit in two columns; a card whose 1:1 drawing is wider than a column spans both.
  const column = (printable - COLUMN_GAP_MM) / 2 - CARD_INSET_MM
  const svgs = c.kind === 'flying' ? [] : bendSvgs(c, printable - CARD_INSET_MM)
  const narrow = svgs.every(s => svgWidthMm(s) <= column)
  const stripW = narrow ? column : Math.min(170, printable - CARD_INSET_MM)
  let drawing: string
  if (c.kind === 'flying') drawing = '<p class="muted">Flying wire: no bend drawing, route it freely (the cut includes slack).</p>'
  else {
    drawing = svgs.map(s => `<div class="drawing">${s}</div>`).join('\n')
    if (c.bends.length === 0) drawing += '\n<p class="muted">no bends</p>'
  }
  return `<section class="card${narrow ? '' : ' wide'}" id="card-${esc(c.id)}">
${scaleBar()}
<div class="card-head">
<span class="card-id">${esc(c.id)}</span>
<span class="kind">${KIND_LABEL[c.kind]}</span>
<span class="net"><span class="swatch" style="background:${color}"></span>${net}</span>
<span class="material">${esc(material(c))}</span>
<span>${SIDE_LABEL[c.side]}</span>
<span class="mono">${esc(c.start)} → ${esc(c.end)}</span>
</div>
<p class="cut">Cut ${mmExact(c.cutMm)}</p>
<p class="breakdown mono">${esc(breakdownLine(c, board.bench.roundToMm))}</p>
${c.note ? `<p class="note">${esc(c.note)}</p>` : ''}
${showStrip ? `<div class="strip">${stripBarSvg(c, stripW)}</div>` : ''}
${c.kind !== 'trail' && c.cutMm > 0 ? `<p class="hint">${esc(SPARE_TAIL_LABEL)}</p>` : ''}
${drawing}
<p class="ticks">${tick(id(`card:${c.id}`), 'cut / stripped / bent')}</p>
</section>`
}

function cards(m: BenchModel, board: BoardFile, printable: number, id: (k: string) => string): string {
  return `<section id="cards" class="page">
<h2>Wire cards</h2>
<p class="hint">Lay the cut wire on the drawing from the dashed start; bend at each marked corner. Bend drawings are 1:1. Strip bars are not to scale; their marks are measured from the start end.</p>
${m.cards.length ? `<div class="columns">\n${m.cards.map(c => card(c, board, printable, id)).join('\n')}\n</div>` : '<p>No trails or wires.</p>'}
</section>`
}

function legFolds(m: BenchModel, pitchMm: number, id: (k: string) => string): string {
  const rows = m.legFolds.map(f => `<div class="fold">
${tick(id(`fold:${f.lead}`))}
<div><p><strong>${esc(f.lead)}</strong> <span class="mono">${esc(f.from)} → ${esc(f.to)}</span></p><p>${esc(f.note)}</p></div>
<div class="sketch">${legFoldSvg(f, pitchMm)}</div>
</div>`)
  return `<section id="legfolds" class="page">
<h2>Leg-fold bridges</h2>
${rows.length ? `<p class="hint">Sketches are 3× scale, solder side.</p>\n${rows.join('\n')}` : '<p>No leg-fold bridges.</p>'}
</section>`
}

/** `columns`: print in two columns (short rows only; the must-not-beep reasons are too long). */
function meterList(title: string, rows: MeterRow[], prefix: string, id: (k: string) => string, columns: boolean): string {
  if (!rows.length) return `<h3>${esc(title)}</h3>\n<p>Nothing to test.</p>`
  const groups = [...new Set(rows.map(r => r.group))]
  const body = groups.flatMap(g => [g, ...rows.filter(r => r.group === g).map(r => [
    tick(id(`${prefix}:${r.a}|${r.b}`)),
    `<span class="mono">${esc(r.a)}</span>`,
    `<span class="mono">${esc(r.b)}</span>`,
    esc(r.expect),
    esc(r.why)
  ])])
  return `<h3>${esc(title)}</h3>\n<div${columns ? ' class="columns"' : ''}>${table(['Done', 'Probe A', 'Probe B', 'Expect', 'Why'], body, 'meter')}</div>`
}

function shorted(k: number): string {
  if (k === 0) return ''
  const what = k === 1 ? '1 net left out of this list: it is shorted' : `${k} nets left out of this list: they are shorted`
  return `\n<p class="note-shorted"><strong>${what} (see the errors at the top).</strong></p>`
}

function meter(m: BenchModel, id: (k: string) => string): string {
  return `<section id="meter" class="page">
<h2>Meter tests</h2>
<p class="hint">Continuity mode, board unpowered.</p>
${meterList('Before power: must beep', m.mustBeep, 'beep', id, true)}${shorted(m.shortedNets)}
${meterList('Before power: must not beep', m.mustNotBeep, 'nobeep', id, false)}
</section>`
}

// ---- styles and script -----------------------------------------------------------------

function css(paper: BenchModel['paper']): string {
  return `
:root { --ink: #16201b; --muted: #5b6a62; --bg: #ffffff; --line: #c9d3cd; --card: #ffffff; --err-bg: #fdecea; --err: #b3261e; }
@media screen and (prefers-color-scheme: dark) {
  :root { --ink: #e4ebe7; --muted: #a2b1a9; --bg: #121815; --line: #34413a; --card: #18201c; --err-bg: #3a1714; --err: #ff8a80; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0 auto; padding: 16px; max-width: 960px; color: var(--ink); background: var(--bg);
  font: 15px/1.45 -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }
h1 { font-size: 1.6em; margin: 0 0 4px; }
h2 { font-size: 1.25em; margin: 24px 0 8px; }
h3 { font-size: 1.1em; margin: 16px 0 6px; }
h4 { font-size: 1em; margin: 12px 0 4px; }
p { margin: 4px 0; }
.meta, .hint, .muted { color: var(--muted); }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.errors { margin: 12px 0; padding: 8px 12px; border: 2px solid var(--err); background: var(--err-bg); color: var(--err); }
.errors ul { margin: 4px 0 0; padding-left: 20px; }
button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); }
.drawing, .scale, .strip, .sketch { overflow-x: auto; max-width: 100%; }
.drawing svg, .scale svg, .sketch svg { display: block; max-width: none; }
.strip svg { display: block; max-width: 100%; height: auto; }
.drawing.fitted { overflow: hidden; }
.drawing.fitted svg { display: block; max-width: 100%; height: auto; }
.fitted-note { margin: 4px 0 8px; }
.drawing, .sketch, .strip, .scale { background: #ffffff; border-radius: 4px; }
.scale { display: inline-block; margin: 4px 0; }
.pair { display: flex; gap: ${OVERVIEW_GAP_MM}mm; align-items: flex-start; }
.pair figure, .stack figure { margin: 0 0 8px; min-width: 0; }
.pair figure:first-child { flex: none; }
.pair figure:last-child { flex: 0 1 auto; min-width: 0; }
figcaption { font-weight: 600; margin-bottom: 4px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid var(--line); }
th { font-size: 0.85em; color: var(--muted); }
tr.group th { padding-top: 10px; font-size: 0.95em; color: var(--ink); border-bottom: 1.5px solid var(--ink); }
.tick input { appearance: none; -webkit-appearance: none; width: 18px; height: 18px; margin: 0 6px 0 0;
  border: 1.5px solid var(--ink); border-radius: 2px; background: transparent; vertical-align: middle; }
.tick input:checked { background: var(--ink); box-shadow: inset 0 0 0 3px var(--bg); }
.tick { display: inline-flex; align-items: center; gap: 2px; cursor: pointer; }
.card { margin: 12px 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card);
  break-inside: avoid; page-break-inside: avoid; }
.card-head { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; }
.card-id { font-weight: 700; font-size: 1.15em; }
.swatch { display: inline-block; width: 12px; height: 12px; margin-right: 5px; border: 1px solid #2b2f2d; vertical-align: -1px;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cut { font-size: 1.6em; font-weight: 700; margin: 6px 0 0; }
.breakdown { font-size: 0.8em; color: var(--muted); }
.note { font-style: italic; }
.fold { display: grid; grid-template-columns: auto 1fr auto; gap: 8px 12px; align-items: start; padding: 8px 0;
  border-bottom: 1px solid var(--line); break-inside: avoid; page-break-inside: avoid; }
footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid var(--line); }
#sections-panel { position: fixed; top: 8px; right: 8px; z-index: 10; max-width: 15rem; font-size: 13px;
  padding: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); opacity: 0.92; }
#sections-panel button { padding: 3px 8px; }
#sections-body { margin-top: 6px; }
#sections-body label { display: flex; gap: 6px; align-items: center; padding: 3px 2px; cursor: pointer; }
#sections-body .row { display: flex; gap: 6px; margin-top: 6px; }
.section-off { display: none !important; }
@media screen and (max-width: 600px) {
  #sections-panel { position: static; max-width: none; margin-bottom: 8px; opacity: 1; }
  body { padding: 12px; font-size: 16px; }
  table, thead, tbody, tr, th, td { display: block; }
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  tr { padding: 8px 0; border-bottom: 1px solid var(--line); }
  tr.group { border-bottom: 0; padding-bottom: 0; }
  tr.group th { padding: 10px 0 2px; }
  td { border: 0; padding: 2px 0; }
  td::before { content: attr(data-label) ": "; color: var(--muted); font-size: 0.85em; }
  td:empty { display: none; }
  td:nth-child(-n+3) { display: inline-block; margin-right: 14px; }
  td:first-child::before { content: none; }
  .pair { display: block; }
  .fold { grid-template-columns: auto 1fr; }
  .fold .sketch { grid-column: 1 / -1; }
}
@page { size: ${paper === 'a4' ? 'A4' : 'letter'}; margin: 12mm; }
@page landscape { size: ${paper === 'a4' ? 'A4' : 'letter'} landscape; margin: 12mm; }
.enlarged.landscape { page: landscape; }
@media print {
  :root { --ink: #000000; --muted: #333333; --bg: #ffffff; --line: #999999; --card: #ffffff; --err-bg: #ffffff; --err: #000000; }
  body { max-width: none; padding: 0; font-size: 10pt; color: #000; background: #fff; }
  .screen-only, #sections-panel { display: none; }
  .page { break-before: page; page-break-before: always; }
  /* the first section left on the sheet follows the header on the same page, not a blank one */
  .page.section-first:not(.enlarged) { break-before: auto; page-break-before: auto; }
  /* belt and braces: nothing may push the page wider, or the browser shrinks every page */
  .drawing, .scale, .strip, .sketch, section, figure { overflow: hidden; }
  .errors { border-width: 2pt; }
  .tick input { width: 4mm; height: 4mm; border: 0.3mm solid #000; background: #fff; box-shadow: none; }
  tr, h2, h3, h4, figure { break-inside: avoid; page-break-inside: avoid; }
  h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
  .columns { columns: 2; column-gap: ${COLUMN_GAP_MM}mm; }
  .columns .card { margin: 0 0 4mm; padding: 2mm 3mm; }
  .columns .card.wide { column-span: all; }
  tr.group { break-after: avoid; page-break-after: avoid; }
  .meter { font-size: 8.5pt; }
  .meter th, .meter td { padding: 0.8mm 1.2mm; }
  .meter td:nth-child(2), .meter td:nth-child(3), .meter td:nth-child(4) { white-space: nowrap; }
  .meter .tick input { width: 3.5mm; height: 3.5mm; margin: 0; }
}
`
}

function script(key: string): string {
  // JSON keeps the key a valid JS string; `<` is escaped so a board name cannot close the script.
  const k = JSON.stringify(key).replace(/</g, '\\u003c')
  return `(function () {
  var KEY = ${k};
  function load() {
    var s = null;
    try { s = window.localStorage.getItem(KEY); } catch (e) { s = null; }
    var t = null;
    try { t = s ? JSON.parse(s) : null; } catch (e) { t = null; }
    return t && typeof t === 'object' ? t : {};
  }
  function save(t) {
    try { window.localStorage.setItem(KEY, JSON.stringify(t)); } catch (e) { /* storage unavailable */ }
  }
  function clear() {
    try { window.localStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ }
  }
  var SKEY = KEY + ':sections';
  function loadOff() {
    var s = null;
    try { s = window.localStorage.getItem(SKEY); } catch (e) { s = null; }
    var a = null;
    try { a = s ? JSON.parse(s) : null; } catch (e) { a = null; }
    return Array.isArray(a) ? a : [];
  }
  function saveOff(a) {
    try { window.localStorage.setItem(SKEY, JSON.stringify(a)); } catch (e) { /* storage unavailable */ }
  }
  function sections() {
    var panel = document.getElementById('sections-panel');
    if (!panel) return;
    var off = loadOff();
    var boxes = Array.prototype.slice.call(panel.querySelectorAll('input[data-section]'));
    function apply() {
      var first = true;
      var hidden = [];
      boxes.forEach(function (b) {
        var id = b.getAttribute('data-section');
        var sec = document.getElementById(id);
        if (!sec) return;
        sec.classList.remove('section-first');
        if (b.checked) {
          if (first) sec.classList.add('section-first');
          first = false;
        } else hidden.push(id);
        sec.classList.toggle('section-off', !b.checked);
      });
      saveOff(hidden);
    }
    boxes.forEach(function (b) {
      b.checked = off.indexOf(b.getAttribute('data-section')) < 0;
      b.addEventListener('change', apply);
    });
    function setAll(on) { boxes.forEach(function (b) { b.checked = on; }); apply(); }
    document.getElementById('sections-all').addEventListener('click', function () { setAll(true); });
    document.getElementById('sections-none').addEventListener('click', function () { setAll(false); });
    var toggle = document.getElementById('sections-toggle');
    var body = document.getElementById('sections-body');
    toggle.addEventListener('click', function () {
      var open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    boxes.forEach(function (b) {
      var sec = document.getElementById(b.getAttribute('data-section'));
      if (sec) sec.classList.toggle('section-off', !b.checked);
    });
    apply();
    panel.hidden = false;
  }
  document.addEventListener('DOMContentLoaded', function () {
    sections();
    var ticks = load();
    var boxes = document.querySelectorAll('input[data-tick]');
    Array.prototype.forEach.call(boxes, function (b) {
      var id = b.getAttribute('data-tick');
      b.checked = ticks[id] === true;
      b.addEventListener('change', function () {
        if (b.checked) ticks[id] = true; else delete ticks[id];
        save(ticks);
      });
    });
    var btn = document.getElementById('clear-ticks');
    if (btn) btn.addEventListener('click', function () {
      ticks = {};
      clear();
      Array.prototype.forEach.call(boxes, function (b) { b.checked = false; });
    });
  });
})();`
}

/** The id and heading of a rendered section (they are all `<section id=".."...>\n<h2>..</h2>`). */
function sectionHead(html: string): { id: string, heading: string } {
  const mt = /^<section id="([a-z]+)"[^>]*>\s*<h2>([^<]*)<\/h2>/.exec(html)
  if (!mt) throw new Error('bench section without an id and heading')
  return { id: mt[1]!, heading: mt[2]! }
}

/** The on-screen "Sections" panel (never printed; shown by the script only, so no-JS output is unchanged). */
function panel(parts: { id: string, heading: string }[]): string {
  const boxes = parts.map(p => `<label><input type="checkbox" data-section="${p.id}" checked> ${p.heading}</label>`).join('\n')
  return `<aside id="sections-panel" aria-label="Sections" hidden>
<button type="button" id="sections-toggle" aria-expanded="false" aria-controls="sections-body">Sections</button>
<div id="sections-body" hidden>
${boxes}
<div class="row"><button type="button" id="sections-all">All</button><button type="button" id="sections-none">None</button></div>
</div>
</aside>`
}

/** Today's date as YYYY-MM-DD, local time. */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---- document ------------------------------------------------------------------------

/**
 * The tick-store key part for a board file: the first 12 hex chars of its sha256.
 * The CLI export (from the file's bytes) and the API's bench sheet (from the board id and head revision) both use this.
 */
export function tickKey(sha256Hex: string): string {
  return sha256Hex.slice(0, 12)
}

/**
 * The whole bench sheet. `hash` (e.g. of the board file's text) keys the phone ticks so they
 * reset when the board changes; without it the revision is used. `date` (YYYY-MM-DD) pins the
 * "generated" date; it defaults to today.
 */
export function benchHtml(board: BoardFile, opts: { hash?: string, date?: string } = {}): string {
  const m = benchModel(board)
  const printable = PRINTABLE_MM[m.paper]
  const id = tickIds()
  const date = opts.date ?? today()
  const key = `wirebender:${m.name}:${opts.hash ?? m.revision}`
  const parts = [
    overview(board, printable), enlarged(board, m.paper), placement(m, id), cards(m, board, printable, id),
    legFolds(m, board.board.pitchMm, id), meter(m, id)
  ].map(html => ({ html, ...sectionHead(html) }))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(m.name)}: bench sheet</title>
<style>${css(m.paper)}</style>
<script>${script(key)}</script>
</head>
<body>
${panel(parts)}
${header(m, date)}
${parts.map(p => p.html).join('\n')}
<footer><p class="advisory"><strong>${esc(ADVISORY)}</strong></p></footer>
</body>
</html>
`
}
