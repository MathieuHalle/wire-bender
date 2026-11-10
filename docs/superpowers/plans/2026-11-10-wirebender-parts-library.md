# Parts library, batch 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the batch-1 maker parts (header/socket/DIP/terminal families, LED, electrolytic, TO-92, tact button, trimmers, SRD relay) with 2D bodies and detailed 3D shapes.

**Architecture:** `FOOTPRINTS` becomes generated from family functions; each footprint names a `shape` that `partPrims` switches on. Two new 3D prims (`extrude`, `lathe`) carry the round and D-shaped bodies. No board-format change.

**Tech Stack:** TypeScript `core/` (no Node/DOM), Vue/Nuxt app, three.js via TresJS, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-wirebender-parts-library-design.md`

## Global Constraints

- `core/` has no UI/Node deps: no Vue, Nuxt, Node `fs`, or DOM.
- Footprint ids stay strings; the board format gets no new keys.
- `header-1x5`, `dip8`, `terminal-2p-508` (and every other existing footprint) keep their exact `pins`, `body`, `mark`, `tab`, `tabPin` values.
- Two-lead pin `b` is the cathode / minus.
- Advisory only: never claim a board is safe to power.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` pass after every task.

## Review Focus

- A board using only old footprints renders the same 3D prims as before (snapshot the prim list of the channel-board-2 fixture before Task 1 and compare after every task).
- Rotation 90/180/270 and `flip` on every new footprint: pins land on the grid, the body rect contains every pin of DIP/header/terminal parts, marks follow the pins.
- An id just outside a family (`header-1x41`, `dip7`, `dip42`, `terminal-7p-508`, `cap-elec-7x7`) is refused as an unknown footprint.
- New prims have finite bounds and render (no NaN from a zero-length profile or a degenerate outline).
- The 2D view draws a round body as a circle for LEDs and electrolytics lying in any direction.

---

### Task 1: Families, `shape`, and the old ids unchanged

**Files:** Modify `core/footprints.ts`, `core/scene3d/parts.ts`, `core/bench/sheet.ts`, `app/components/board/Parts.vue`, `docs/format/wirebender-1.md`. Test `tests/core/footprints.test.ts`, `tests/core/scene3d-parts.test.ts`.

**Interfaces — Produces:**
- `Footprint.shape: FootprintShape`, `type FootprintShape = 'relay-g5v2' | 'to220' | 'dip' | 'terminal' | 'header' | 'socket' | 'polyfuse' | 'axial' | 'cap-disc' | 'led' | 'cap-elec' | 'to92' | 'button' | 'trimmer-3296w' | 'trimmer-3362p' | 'relay-srd'`.
- `Footprint.dip?: { rows: 3 | 6, socket: boolean }`, `Footprint.header?: { rows: 1 | 2 }`.
- `Footprint.mark` gains `'flat-b' | 'minus-b'`.
- Family builders (not exported beyond the module unless tests need them): `headerFp(rows, n)`, `socketFp(rows, n)`, `dipFp(n, wide, socket)`, `terminalFp(n)`.

- [ ] Before any change: write `tests/core/scene3d-snapshot.test.ts` that builds the scene of `tests/fixtures/channel-board-2.json` and compares `prims` to a stored JSON snapshot (vitest `toMatchFileSnapshot`). Run it once to record.
- [ ] Test: `FOOTPRINTS['header-1x5']`, `['dip8']`, `['terminal-2p-508']` equal the old literals (copy them into the test) apart from the new `shape`/`dip`/`header` keys; `header-2x3` pins `1`(0,0) `2`(0,1) `3`(1,0) … `6`(2,1); `dip16` pin 9 at (3,7); `dip28-wide` pin 15 at (6,13); out-of-family ids (`header-1x41`, `header-1x0`, `dip7`, `dip42`, `dip22-wide`, `terminal-7p-508`) are absent.
- [ ] Implement the generators. DIP body: width `rows*2.54 - 1.27` (0.3": 6.35 as today; 0.6": 13.97), length `N/2 * 2.54 - 0.36`; height 4.5 (socket: 7.5). Header body: `N*2.54 x rows*2.54 - 0.04` (1 row: 2.5 as today), height 8.5. Socket: same outline, body height 8.5, no posts. Terminal: `N*5.08 x 7.6`, height 10.
- [ ] `partPrims` switches on `fp.shape`; the existing cases move under their shape names unchanged; `header` and `dip` builders take any length/row count (DIP notch on the pin-1 end, header triangle at pin 1). New shapes fall to the default box for now.
- [ ] `Parts.vue`: `round` is `fp.body.round || (standing && twoLead)`. `sheet.ts`: `flat-b` → `cathode (flat side) at <b>`, `minus-b` → `minus (stripe) at <b>`.
- [ ] Format doc: replace the id list with the families and singles from the spec table.
- [ ] Run test/typecheck/lint; commit `feat(core): footprint families and a shape per footprint`.

### Task 2: `extrude` and `lathe` prims

**Files:** Modify `core/scene3d/types.ts`, `core/scene3d/index.ts` (`sceneBounds`), `app/utils/scene3dThree.ts`. Test `tests/core/scene3d-bounds.test.ts` (new), and the existing three.js mesh test if one exists.

**Interfaces — Produces:**
- `{ kind: 'extrude', outline: XZ[], y0: number, y1: number }` — a closed outline (counter-clockwise seen from the top, x/z board mm), vertical walls.
- `{ kind: 'lathe', axis: XZ, profile: { r: number, y: number }[] }` — revolved about the vertical line at `axis`; profile from bottom to top.
- Helpers in `core/scene3d/shapes.ts`: `roundedRect(r: Rect, radius: number, steps?: number): XZ[]`, `dOutline(c: XZ, radius: number, flatDir: XZ, flatAt: number, steps?): XZ[]`.

- [ ] Test bounds: an extrude square 0..2 x 0..3 from y 1 to 4 → min [0,1,0] max [2,4,3]; a lathe at (5,5) with profile r up to 2.5, y 0..8 → min [2.5,0,2.5] max [7.5,8,7.5]. `roundedRect` returns points all inside the rect and touching each edge; `dOutline` has a straight edge at `flatAt`.
- [ ] Implement types, bounds and helpers; three.js: `ExtrudeGeometry` from a `Shape` of (x, -z) rotated to stand vertical (or a hand-built prism), `LatheGeometry` with 32 segments translated to `axis`. Keep `userData.tag`.
- [ ] Commit `feat(3d): extrude and lathe shapes`.

### Task 3: LED and electrolytic capacitor

**Files:** `core/footprints.ts`, `core/scene3d/parts.ts`, `core/scene3d/dims.ts` (colours), `app/components/board/Parts.vue` (marks). Tests in `tests/core/footprints.test.ts`, `tests/core/scene3d-parts.test.ts`, `tests/core/bench-sheet.test.ts`.

- [ ] Footprints: `led-3mm` (body round 3.8 dia, height 6.5, twoLead span 1–1, mark `flat-b`), `led-5mm` (5.8 dia, height 9.6). `cap-elec-DxH`: body round D, height H+0.5, span 1–1 for D ≤ 6.3, 2–2 for 8 and 10, mark `minus-b`.
- [ ] 3D LED: lathe — 1 mm leg stand-off, flange (rim) 0.8 tall at the full diameter with a flat cut on the `b` side (extrude for the rim, lathe for the body and dome), translucent-looking colour by `value`/`label` (red/green/blue/yellow/white words, else red). Legs straight.
- [ ] 3D electrolytic: lathe can with a rounded top edge and a shallow scored top, a lighter minus stripe on the `b` side (a thin extrude band on the can wall), a 0.5 mm rubber base.
- [ ] 2D: round bodies; `flat-b` draws a chord on the `b` side of the circle, `minus-b` a filled band on the `b` side.
- [ ] Tests: placed at rotations 0/90 the body circle is centred on the lead midpoint; 3D bounds height equals `heightMm` ±0.05; the minus stripe / flat is nearer lead b than lead a; bench sheet orientation text.
- [ ] Commit `feat(parts): LEDs and electrolytic capacitors`.

### Task 4: TO-92, tact buttons, trimmers

**Files:** as Task 3.

- [ ] `to92`: pins `1`,`2`,`3` (0,0),(1,0),(2,0); body rect 4.8 (along pins) x 3.8, centred over pin 2, height 7.5 (3 mm stand-off, body 4.5); mark `flat`, `tab` direction (0,1) (flat face toward +y at rotation 0). 3D: extrude `dOutline`, a small text-plate mark on the flat face; legs straight, the outer two splayed (tube) from 2.54 under the body to the holes.
- [ ] `button-6x6-hH`: body 6 x 6 centred on the pin box, height H; 3D: square base 3.5 tall, round plunger (lathe) to H, four corner bumps; legs straight. Pins passive.
- [ ] `trimmer-3296w`: rect 9.5 x 4.8 centred over pin 2, height 10; 3D: blue box, brass screw (lathe) on top at one end. `trimmer-3362p`: 6.8 x 7.0, height 4.5; blue body, white round dial with a slot. Pin `2` gets role `passive`; doc says it is the wiper.
- [ ] Tests: pins and body rect at rotation 0/90/flip, TO-92 tab direction after rotation (as the TO-220 test), bench sheet `flat side toward …`, every body's top at `heightMm`.
- [ ] Commit `feat(parts): TO-92, tact buttons and trimmers`.

### Task 5: SRD relay

**Files:** as Task 3.

- [ ] Pins from KiCad's `Relay_SPDT_SANYOU_SRD_Series_Form_C` footprint (fetch it from the KiCad footprints repo), converted to hole offsets from `COM` by rounding mm/2.54; a comment lists the datasheet mm next to each snapped offset; a test asserts each pin is within 0.6 mm of its datasheet place, else the footprint name says "(bend to fit)".
- [ ] Body 19 x 15.5, height 15, mark `pin1`-style dot by the coil; 3D: blue box with rounded vertical edges (`extrude` of `roundedRect`), a printed label plate on top.
- [ ] Commit `feat(parts): Songle SRD relay`.

### Task 6: Finish

- [ ] Format doc and README footprint lists match `Object.keys(FOOTPRINTS)` (a test generates the family list from the doc patterns and compares).
- [ ] Whole-branch review on the most capable model; fix; browser check on a scratch server (port 3005, scratch data dir) with a test board that has one of every new part, both sides and 3D.
