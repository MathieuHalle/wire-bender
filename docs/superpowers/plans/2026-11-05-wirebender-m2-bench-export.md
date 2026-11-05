# WireBender milestone 2 (bench export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From any board file, produce the bench sheets: parts placement, one wire card per
trail/wire (cut → strip → 1:1 bend drawing), leg-fold bridges, and the beep / no-beep meter
list — as one self-contained HTML file that prints at true 1:1 and also works offline on a
phone or iPad.

**Architecture:** A pure model layer `core/bench/` (lengths, bends, strip marks, placement
order, meter lists — data only, unit-tested) and a pure renderer `export/` (SVG strings in mm +
one HTML document string with inline CSS and a tiny inline script). The CLI writes the file;
a Nitro route serves the same HTML for the board being edited; the editor gets a
"Bench sheet" button. No new dependencies.

**Tech Stack:** TypeScript, Vitest, existing Nuxt 4 / Nitro / tsx setup.

**Spec:** `docs/superpowers/specs/2026-11-05-wirebender-design.md` §6 (bench export), §3
(bench settings, wire kinds), §2 anti-goals. Build-order step 2 (§11).

## Global Constraints

- All M1 Global Constraints still apply (`docs/superpowers/plans/2026-11-05-wirebender-m1-editor.md`): core/ has no Vue/Nuxt/fs/DOM imports; English; hole names `G13`; pitch 2.54 mm; advisory sentence; commit trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01J81HjMZYUjAKfCSSaUaXzJ`.
- `export/` is pure too (string in, string out): no Vue, no fs, no DOM at build time. The generated HTML may contain an inline script for the phone ticks only.
- The exported HTML is fully self-contained: no external URLs (no fonts, no CDNs, no images by link). It must open from `file://` with no network.
- Every drawing meant to be 1:1 is an `<svg>` whose `width`/`height` attributes are in `mm` and whose `viewBox` is in mm, and every page holding one shows a **10 mm scale bar** labelled `10 mm — measure to check print scale`.
- Print: `@page { size: letter; margin: 12mm }` by default (owner is in Canada); `bench.paper: 'letter' | 'a4'` switches it. No content wider than the printable width (letter 191.9 mm, A4 186 mm).
- The last line of every exported document (screen and print) is the advisory sentence `Advisory only. Check the board with a meter before powering it.` (import `ADVISORY` from `cli/format.ts` — move it to `core/advisory.ts` and re-export from cli/format.ts so export/ doesn't import cli/).
- Lengths shown to the owner are in mm, rounded: cut length up to `bench.roundToMm`; segment lengths and strip marks to 0.5 mm.
- The export never changes the board file.

## Review Focus

1. **Print scale drifting from 1:1** (browser "fit to page", an SVG without mm units, a drawing wider than the page): every 1:1 SVG carries mm units, no 1:1 drawing exceeds the printable width (long wires split across rows with a "continues" marker), and the scale bar is on every such page. → Task 3 tests `bend drawing has mm units`, `long wire splits to fit the page`; Task 4 test `every 1:1 page has a scale bar`.
2. **A board with errors** (open nets, shorts): the export still renders, but its first section is a red "This board has N errors" box listing them, so nobody builds a board the check rejects without seeing it. → Task 4 test `errors are shown first`.
3. **Flying wires and trails with zero bends, and 1-point leftovers**: a flying wire gets a cut/strip card with no bend drawing; a straight trail gets a card with "no bends"; a 1-point trail (half-drawn) is skipped with a note. → Task 1 tests.
4. **Phone use**: the file is readable at 390 px wide without horizontal scrolling (drawings scroll inside their own box), ticks survive a reload (localStorage keyed by board name + content hash, wrapped in try/catch so it still works where storage is blocked). → Task 4 tests on the HTML string + Task 5 browser check.
5. **Mirrored bottom side**: bend directions and the overview of the solder side are as seen from the side being worked on (bottom = board turned over), consistently between the overview, the bend drawing and the words "left/right". → Task 1 test `bend direction on the bottom is mirrored`; Task 3 test `bottom drawing is mirrored`.

---

## File Structure

```
core/advisory.ts            ADVISORY (moved from cli/format.ts, re-exported there)
core/bench/cards.ts         wireCards(board): WireCard[]   (cut, strip, bends)
core/bench/sheet.ts         benchModel(board): BenchModel  (placement, leg-folds, meter lists, cards, check summary)
export/svg.ts               svg helpers: boardOverviewSvg, bendSvg, stripBarSvg, legFoldSvg, scaleBarSvg
export/benchHtml.ts         benchHtml(board, opts?): string  (the whole document)
cli/wirebender.ts           + `export <file> [-o out.html]`
server/api/bench.get.ts     GET /api/bench → text/html for the current board file
app/pages/index.vue         + "Bench sheet" button (opens /api/bench in a new tab)
core/schema.ts              bench.paper ('letter' | 'a4', default 'letter')
tests/core/bench-cards.test.ts, tests/core/bench-sheet.test.ts, tests/export/*.test.ts
```

---

### Task 1: Wire cards (cut, strip, bends)

**Files:**
- Create: `core/bench/cards.ts`, `core/advisory.ts`
- Modify: `core/schema.ts` (add `bench.paper`, default `'letter'`), `cli/format.ts` (re-export ADVISORY), `core/index.ts`
- Test: `tests/core/bench-cards.test.ts`

**Interfaces:**
- Consumes: `BoardFile`, `parseHole`, `holeMm`, `straightRun`, `buildConnectivity` (for the trail's net).
- Produces:

```ts
interface CardSegment { from: HoleName; to: HoleName; lengthMm: number; bare: boolean }
interface Bend { at: HoleName; index: number; angleDeg: 90 | 180; dir: 'left' | 'right' | 'back' }  // index 1..n in order
interface WireCard {
  id: string; kind: 'trail' | 'laid' | 'flying'; side: Side
  net: string | null; netClass: string | null; color: string | null
  start: HoleName; end: HoleName
  segments: CardSegment[]          // empty for flying
  bends: Bend[]
  breakdown: { pathMm: number; bendsMm: number; leadsMm: number; spareMm: number; slackMm: number }
  cutMm: number                    // ceil((sum of breakdown) / roundToMm) * roundToMm
  strip: { fromStartMm: number; toBare: boolean }[]   // marks where bare/insulated changes, measured along the cut wire from its start end
  stretches: { lengthMm: number; bare: boolean }[]    // the strip bar, in order, summing to the cut length
  note?: string                    // e.g. "half-drawn trail (1 point), skipped"
}
wireCards(board: BoardFile): WireCard[]   // trails first (by id, natural order T2 < T10), then wires
```

  Rules:
  - Path length = sum of segment lengths (hole distance × pitch). Trails: every segment bare. Laid wires: segment i bare iff `bareSegments.includes(i)`. Flying: path = straight-line distance between ends; `slackMm = bench.flyingSlackMm`; no segments, no bends.
  - `bendsMm = bends.length × bench.bendAllowanceMm`; `leadsMm = 2 × bench.endLeadMm`; `spareMm = bench.spareMm`.
  - Stretches: `[endLead bare] + segments (merging neighbours with the same bare flag) + [endLead bare]`, then the rounding surplus (cut − sum) is added to the last stretch. Strip marks are the boundaries between stretches with different `bare` values, measured from the start; `toBare` = the stretch after the mark is bare. An all-bare wire (a trail) has no strip marks.
  - Bend direction: turn from segment i to i+1 at the shared point. Compute the cross product in board coordinates (x right, y down) as seen from the top; on the `bottom` side swap left/right (seen from below). A reversal is `angleDeg: 180, dir: 'back'`. Straight continuation through a point is not a bend (collinear consecutive points are merged into one segment).
  - A trail with fewer than 2 points → a card with `note: "half-drawn trail (1 point), skipped"`, no segments, `cutMm: 0`.
  - Net / class / colour from the trail's connectivity group (single net) or the wire's `color`; null when none or shorted.

- [ ] **Step 1: Write the failing tests:**
  - `spec example: 200 mm cut` — a laid wire whose path is 182.88 mm (e.g. 72 holes of straight runs with 2 bends), defaults → `breakdown {pathMm≈182.88, bendsMm:2, leadsMm:10, spareMm:5, slackMm:0}`, `cutMm: 200`.
  - `mixed wire strip marks` — laid wire with segments [insulated 95 mm-ish, bare 100 mm-ish] (build with holes so that path lengths are exact multiples of 2.54) → `strip` = `[{fromStartMm: 5 + insulatedLen, toBare: true}, ...]` and first mark at 5 mm (`toBare:false`); assert exact values computed from the hole counts.
  - `trail has no strip marks and bare stretches only`.
  - `flying wire: straight distance + slack, no bends` — ends A1 and D5 → path = 2.54 × 5 = 12.7 mm, slack 10, cut = ceil((12.7+0+10+5+10)/5)*5 = 40.
  - `bend direction on the top`: points `[A1, A5, E5]` (right along row A then down) seen from top → `{at:'A5', dir:'right', angleDeg:90}`.
  - `bend direction on the bottom is mirrored`: same points on the bottom → `dir:'left'`.
  - `collinear points merge`: `[A1, A3, A6]` → one segment, no bends.
  - `half-drawn trail skipped with a note`.
  - `cards are ordered T2 before T10, trails before wires`.
- [ ] **Step 2:** `pnpm test tests/core/bench-cards.test.ts` → FAIL.
- [ ] **Step 3:** Implement `core/bench/cards.ts`; move ADVISORY; add `bench.paper` to the schema (strict object; default `'letter'`).
- [ ] **Step 4:** Full suite + typecheck → PASS.
- [ ] **Step 5:** Commit `feat(core): bench wire cards (cut, strip, bends)`.

### Task 2: Placement, leg-folds and meter lists

**Files:**
- Create: `core/bench/sheet.ts`
- Test: `tests/core/bench-sheet.test.ts`

**Interfaces:**
- Consumes: `wireCards`, `placePart`, `buildConnectivity`, `runCheck`.
- Produces:

```ts
interface PlacementRow { step: number; ref: string; name: string; value?: string; holes: string; heightMm: number
                         orientation: string; mounting: 'lying' | 'standing' | 'upright' }
interface LegFoldRow { lead: string; from: HoleName; to: HoleName; note: string }   // "fold D4.b (L3) flat toward L4, solder both"
interface MeterRow { a: string; b: string; expect: 'beep' | 'no beep'; why: string; group: string }
interface BenchModel {
  name: string; revision: number; paper: 'letter' | 'a4'
  check: { errors: Finding[]; stats: CheckResult['stats'] }
  placement: PlacementRow[]; cards: WireCard[]; legFolds: LegFoldRow[]
  mustBeep: MeterRow[]; mustNotBeep: MeterRow[]
}
benchModel(board: BoardFile): BenchModel
```

  Rules:
  - Placement order: lowest body first (`heightMm` ascending, standing parts use their standing height), ties by ref. `holes` = pin list like `1:W8 2:W9 …` (two-lead: `a:L2 b:L1`). `orientation` text from the footprint `mark`: `pin1` → "pin 1 at <hole>", `stripe-b` → "stripe (cathode) at <b hole>", `tab` → "metal tab toward <side: row X / column N>" (derived from the rotated body rect relative to the pins), `flat` → "flat side toward …"; none → "either way".
  - Leg-folds from `board.legFolds` (the lead's own hole is `from`).
  - `mustBeep`: per net with ≥ 2 leads, a chain lead[i] → lead[i+1] (sorted by hole name), `why: "<net> continuous"`, `group: net`. Probe points are written as `REF.pin (HOLE)`.
  - `mustNotBeep`: (a) for each pair of classes in `rules.adjacency` with level `supply`, one row between one lead of each class's first net (e.g. `J3.V12` vs `J3.GND`), `why: "supply not shorted"`, `group: "Shorts the supply"`; (b) every `adjacent` caution with level `supply` or `mcu` from `runCheck`, `why` = its message, `group` = "Shorts the supply" / "Kills the MCU". Harmless cautions are not listed. Deduplicate by unordered hole pair.
  - `check.errors` = findings with severity error.

- [ ] **Step 1: Write the failing tests:** placement order by height; tab orientation text for a to220 at rotation 0 and 90; stripe text for an axial; leg-fold row text; mustBeep chain for a 3-lead net (2 rows); mustNotBeep includes the class-pair supply row and an `mcu` adjacent row, excludes harmless; `benchModel` on `data/channel-board-2.wirebender.json` has 30 placement rows, 35 + 9 cards, 12 leg-folds, 4 errors (snapshot the counts, not the full model).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** full suite + typecheck PASS. **Step 5:** commit `feat(core): bench sheet model (placement, leg-folds, meter lists)`.

### Task 3: SVG drawings at 1:1

**Files:**
- Create: `export/svg.ts`
- Test: `tests/export/svg.test.ts`

**Interfaces:**
- Consumes: `WireCard`, `BoardFile`, `placePart`, `holeMm`.
- Produces (each returns an SVG string or an array of them):

```ts
scaleBarSvg(): string                                     // 10 mm bar + label
boardOverviewSvg(board: BoardFile, side: Side): string    // whole board 1:1: hole grid, labels, part bodies (top solid / bottom dashed), trails of that side, wire ends, joints; bottom mirrored
bendSvgs(card: WireCard, maxWidthMm: number): string[]    // 1:1 shape of the trail/laid wire: segments with lengths, numbered bends with angle + dir, start/end hole names, side label; split into several rows when wider than maxWidthMm, each row ending/starting with "continues ▸" / "◂ continued" at a bend point
stripBarSvg(card: WireCard, widthMm: number): string      // NOT 1:1: bar scaled to widthMm, stretches labelled in mm, ✂ marks with "strip at X mm"
legFoldSvg(row: LegFoldRow): string                       // 3x2 pad sketch, solder side, leg bent to target
```

  - All 1:1 SVGs: `width="<w>mm" height="<h>mm" viewBox="0 0 <w> <h>"`, strokes in mm. Bare copper `#b87333`, insulated in the wire colour (fallback `#1f6fb2`), joints as filled blobs, holes as rings.
  - Bottom side drawings mirrored (x → width − x) with labels kept readable (text not mirrored).
  - Fonts: system stack only (`-apple-system, Segoe UI, Helvetica, Arial, sans-serif`), sizes ≥ 2.2 mm in drawings.

- [ ] **Step 1: Write the failing tests:** `bend drawing has mm units` (regex on width/height/viewBox); `long wire splits to fit the page` (a 250 mm laid wire with maxWidth 180 → ≥ 2 svgs, the first contains "continues"); `bottom drawing is mirrored` (a trail starting at column 1 on the bottom has its start circle at x near the right edge); `overview has every part ref` (board 2: all 30 refs appear); `strip bar labels` (W5-style card → contains "strip at 5 mm" and "strip at 100 mm"); `scale bar is exactly 10 mm` (`<line` from x1 to x2 with x2 − x1 = 10).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(export): 1:1 SVG drawings for the bench sheet`.

### Task 4: The bench HTML document and the CLI export

**Files:**
- Create: `export/benchHtml.ts`
- Modify: `cli/wirebender.ts` (+ `export` command)
- Test: `tests/export/benchHtml.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `benchModel`, all of `export/svg.ts`, `ADVISORY`.
- Produces: `benchHtml(board: BoardFile, opts?: { hash?: string }): string`; CLI `pnpm wirebender export <file> [-o out.html]` (add a `wirebender` script = `tsx --tsconfig tsconfig.cli.json cli/wirebender.ts`; default output `<board file basename>.bench.html` next to the board file; prints the output path; exit 2 on an invalid file).

  Document, in order (each section starts on a new printed page except where noted):
  1. Header: board name, revision, date generated, paper; if `check.errors` is non-empty, a red box "This board has N errors — fix them before building" listing them (Review Focus 2).
  2. Overview: top and bottom `boardOverviewSvg` at 1:1 side by side when they fit the printable width, else stacked; scale bar.
  3. Parts placement table (step, ref, part, value, holes, orientation, mounting) with a tick box per row.
  4. Wire cards: one card per `WireCard`, `break-inside: avoid`; each card shows id, kind, net/class swatch, side, start → end, **Cut N mm** (large), the breakdown line in small mono text, the strip bar (when it has marks or for any laid/flying wire), then the 1:1 bend drawing(s) (trails and laid wires), "no bends" text when straight; tick box "cut / stripped / bent". Scale bar at the top of every printed page of cards (use a repeated header element with `position: running()` fallback: simplest is one scale bar per card).
  5. Leg-fold bridges: one row + sketch each.
  6. Meter test list: "Before power: must beep" then "Before power: must not beep" grouped by `group`, each row with a tick box.
  7. Footer line: the advisory sentence (also the last line of the document).
  - CSS: print styles (`@page` size from `paper`, margins 12 mm, black on white, tick boxes as empty squares) and screen styles (max-width 960 px, readable at 390 px: tables become stacked rows under 600 px, SVG containers `overflow-x: auto`). Dark mode for screen only via `prefers-color-scheme`; print always light.
  - Ticks: `<input type="checkbox" data-tick="<stable id>">`; an inline script stores ticks in `localStorage` under `wirebender:<board name>:<hash or revision>` with every access in try/catch; a "Clear ticks" button. No other script.
- [ ] **Step 1: Write the failing tests:** `document is self-contained` (no `http://` or `https://` in the output, no `<link`, no `src=` except data: URIs if any); `errors are shown first` (a board with an open net → the error box appears before the overview); `every 1:1 page has a scale bar` (count of scale bars ≥ number of overview + card sections); `advisory is the last text`; `paper a4 switches @page`; `ticks use localStorage in try/catch` (string contains `try` around `localStorage`); CLI: `export writes the file and prints its path`, `export on an invalid file exits 2`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** `pnpm wirebender export data/channel-board-2.wirebender.json -o <scratch>/board2.bench.html`, open it in headless Chrome and print to PDF (`chrome --headless=new --print-to-pdf=<scratch>/board2.pdf file://…`); check the PDF page size is letter and count pages (report it). **Step 6:** commit `feat(export): bench sheet HTML and CLI export`.

### Task 5: Serve it from the editor

**Files:**
- Create: `server/api/bench.get.ts`
- Modify: `app/pages/index.vue` (button)
- Test: `tests/server/bench.test.ts`

**Interfaces:**
- Consumes: `readBoard` (Task M1-8, returns `{ok, board, hash}`), `benchHtml`.
- Produces: `GET /api/bench` → 200 `text/html; charset=utf-8` with `benchHtml(board, {hash})`, plus `Content-Disposition: inline; filename="<name>.bench.html"`; 422 text with the parse errors when the file is invalid. Editor header gets a `Bench sheet` button that first waits for any pending save (useBoard status `saved`), then opens `/api/bench` in a new tab; disabled with a tooltip while status is `conflict` or `error`.
- [ ] **Step 1:** failing test for the handler util (valid → html containing the board name; invalid → errors). **Step 2:** implement. **Step 3:** full suite + typecheck + lint.
- [ ] **Step 4: Verify in the browser** (port ≠ 3000/3001, temp board copy): the button opens the sheet; ticks survive a reload; at 390 px wide no horizontal page scroll (drawings scroll in their box); print preview shows letter pages with the scale bar; screenshot each to the owner.
- [ ] **Step 5:** commit `feat: bench sheet from the editor`.

---

## After this plan

Milestone 2 is done when the owner has printed channel board 2's sheet, measured the 10 mm
scale bar as 10 mm, and used the wire cards at the bench. Next plan: 3D view (spec §5).
