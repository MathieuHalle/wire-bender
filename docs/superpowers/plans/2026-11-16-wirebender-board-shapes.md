# Board shapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Round boards and boards with chamfered or notched corners: the outline drawn as cut, missing holes not drawn, refused by the tools and reported by the check.

**Architecture:** An optional `board.shape` in `wirebender/1`; `core/boardShape.ts` answers `holeExists` and
`boardOutline` for everyone (tools, check, 2D, 3D, SVG). Each consumer that tests `cols`/`rows` today asks
it instead.

**Tech Stack:** TypeScript, zod, Vue 3 / Nuxt UI, three.js, Vitest (Node).

**Spec:** `docs/superpowers/specs/2026-11-16-wirebender-board-shapes-design.md`

## Global Constraints

- `core/` has no Vue, Nuxt, Node or DOM imports.
- `board.shape` is optional; a board without it behaves exactly as today. Items on missing holes are
  **check findings, never parse errors**.
- One rule for everyone: `holeExists(board.board, hole)`.
- Hole exists ⇔ in the `cols × rows` grid and its centre ≥ ¼ pitch inside the outline (spec).
- `docs/format/wirebender-1.schema.json` is generated: run `pnpm schema` after the zod change
  (`tests/core/formatDocs.test.ts` compares it).
- Verification: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## Review Focus

1. A mirrored bottom side draws the cut at the mirrored corner (`topLeft` cut appears top-right when
   seen from below). Test in Task 4 (outline through `geo.x`).
2. An L-bend corner of a moved laid-wire end landing on a missing hole is refused. Test in Task 2.
3. A board whose shape now hides an existing trail point still parses and opens; the check reports it.
   Test in Task 3.
4. Corner cuts on a 1-row or 1-column board, and cuts that would empty an edge, are schema errors with a
   clear message, not a crash. Test in Task 1.
5. The 3D label size no longer depends on the first two holes being neighbours. Test in Task 5.

---

### Task 1: The shape in the format and `core/boardShape.ts`

**Files:** Create `core/boardShape.ts`, `tests/core/boardShape.test.ts`; modify `core/schema.ts` (type, zod at
91-97, a check after `checkHoles`), `docs/format/wirebender-1.md` (the `board` table, rules), regenerate
`docs/format/wirebender-1.schema.json` (`pnpm schema`).

**Interfaces (produces):**
- `export type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'`
- `export interface CornerCut { cut: 'chamfer' | 'notch', holes: number }`
- `export type BoardShape = { kind: 'round' } | { kind: 'corners', corners: Partial<Record<Corner, CornerCut>> }`
  (in `core/schema.ts`; `BoardFile['board'].shape?: BoardShape`)
- `holeExists(b: BoardFile['board'], h: Hole): boolean`
- `existingHoles(b: BoardFile['board']): Hole[]` (row by row, A1 first)
- `type Outline = { kind: 'circle', cx: number, cy: number, r: number } | { kind: 'polygon', points: { x: number, y: number }[] }`
  in board mm (A1 at 0, 0; `holeMm`); a plain rectangle is a 4-point polygon.
- `boardOutline(b: BoardFile['board'], marginPitch = 0.5): Outline` — `marginPitch` is how far past the
  outer hole centres the edges sit (2D 0.5, 3D 1.5). Circle: centre of the grid, `r = (min(cols, rows) / 2 - 0.5 + marginPitch) × pitch`.
  Chamfer of `n` (corner-relative indices `dc`, `dr` from 0): the line `dc + dr = n − 0.5 − (marginPitch − 0.5)·√2`;
  notch of `n`: outer edges at `−marginPitch`, inner corner at `(n − 0.5, n − 0.5)` whatever the margin.
- `outlinePoints(b, marginPitch = 0.5, segments = 64): { x: number, y: number }[]` (the circle as a polygon).

- [ ] **Step 1: Failing tests** — `holeExists`: no shape → every grid hole, none outside; round 2 × 2 → all 4;
  round 10 × 10 → not A1/J10/B2, yes E1 and A5 (`(1,5)`), yes C2 (`(3,2)`) no B2 (`(2,2)`); notch 2 at
  `topLeft` → A1 A2 B1 B2 missing, A3 and C1 kept; chamfer 2 at `bottomRight` on 10 × 10 → J10 J9 I10 missing,
  I9 kept. `existingHoles` count for round 10 × 10 matches `holeExists`. For `marginPitch` 0.5 and 1.5 and each
  shape: every existing hole is inside the outline polygon (`outlinePoints`, point-in-polygon) and every
  missing grid hole is outside. Schema: `{ kind: 'round' }` and a corners shape parse; `holes: 0`, an unknown
  corner, `cut: 'round'` are errors; `topLeft 5 + topRight 5` on 10 columns →
  `board.shape: the top edge's corner cuts leave no hole (5 + 5 of 10)`; a board without `shape` parses as
  before; a trail on a missing hole still parses (Focus 3 relies on it).
- [ ] **Step 2: Run** `pnpm vitest run tests/core/boardShape.test.ts` → FAIL.
- [ ] **Step 3: Implement**; document `shape` in the `board` table and a rule line "Holes outside the shape
  are missing: nothing may be on them (a check error, not a format error)"; `pnpm schema`.
- [ ] **Step 4: Run** `pnpm test` → PASS (formatDocs included).
- [ ] **Step 5: Commit** `feat(core): board shapes in the format (round, corner cuts)`

### Task 2: Tools refuse missing holes

**Files:** `core/edit.ts` (`rejection`), `core/move.ts` (pins/folds, wire points, wire-end target, the L-bend
`cornerHole`), `app/utils/movePointer.ts`, `app/composables/useTools.ts` (`onMoveClick`),
`app/components/BoardSide.vue` (`inBoard`, `holeAt`, the band clamp); tests in `tests/core/edit.test.ts`,
`tests/core/move.test.ts`, `tests/app/movePointer.test.ts`, `tests/app/useTools.test.ts`.

**Interfaces:** Consumes `holeExists`. Changes `hoverHole(fc, fr, exists: (h: Hole) => boolean, snapAll)`
(the predicate replaces `cols, rows`; BoardSide passes `h => holeExists(board.board, h)`).
Reasons: pencil `Hole ${name} is off the board.`; Move as today (`… would be off the board.`).

- [ ] **Step 1: Failing tests** — on a round 10 × 10: the pencil refuses A1 with `Hole A1 is off the board.`;
  `movePart` onto a spot with a pin on a missing hole → `R1 would be off the board.`; `moveWire` likewise;
  `moveWireEnd` target on a missing hole → off the board; a laid end whose L corner falls on a notched corner
  (end in line neither way, row-first corner on a missing hole) → `Wire W1 would be off the board.` (Focus 2);
  `hoverHole` with a predicate returns null on a missing hole in both modes; `onMoveClick` holding ignores a
  click on a missing hole (target unchanged).
- [ ] **Step 2: Run** the four files → FAIL.
- [ ] **Step 3: Implement**; the `nameless` (`col < 1 || row < 1`) ghost cases stay as they are.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(core,app): the tools refuse holes outside the board's shape`

### Task 3: The check reports items off the shape

**Files:** `core/check/context.ts` (`onBoard` → `holeExists`), `core/check/placement.ts` (the `blockedHole`
"Off the board" block); test `tests/core/check/placement.test.ts` (or the file the existing "Off the board"
test is in).

- [ ] **Step 1: Failing tests** — round 10 × 10: a part pin on A1 → the existing pin message; a trail point on
  A1 → error `Off the board: trail T1 point A1 is outside the board`; a wire point → `… wire W1 point A1 …`; a
  leg fold to A1 → `… leg fold of R1.a at A1 …`; on a plain board none of these appear (no regression).
- [ ] **Step 2–4:** run → FAIL, implement (rule `blockedHole`, severity `error`, `holes: [the hole]`), run `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(check): items outside the board's shape are off the board`

### Task 4: Draw the shape in 2D and the SVG overview

**Files:** `app/components/board/Holes.vue` (outline element, `holes` from `existingHoles`), `export/svg.ts`
(`boardOverviewSvg`: outline, holes); create `app/utils/outlinePath.ts` with
`outlineSvg(b: BoardFile['board'], geo: Pick<Geo, 'x' | 'y'>, marginPitch = 0.5): { kind: 'circle', cx, cy, r } | { kind: 'path', d: string }`
(the outline through the side's mirroring); tests `tests/app/outlinePath.test.ts`, `tests/export/svg.test.ts`.

- [ ] **Step 1: Failing tests** — `outlineSvg` of a `topLeft` notch on an `lr`-mirrored geo puts the notch's
  points at the right (x mirrored) (Focus 1); a plain board gives the same rectangle as today's
  (`-half, -half, span + pitch, rows × pitch`); `boardOverviewSvg` of a round 10 × 10 draws `existingHoles`
  circles (count) and one outline `<circle`; a plain board's SVG is unchanged (byte-compare with today's output
  for the fixture).
- [ ] **Step 2–4:** run → FAIL, implement (`Holes.vue`: a `<circle>` or `<path>` with today's fill/stroke; keep
  the `rx="0.6"` rect when there is no shape), run `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(app,export): draw board shapes in 2D and the overview`

### Task 5: The shape in 3D

**Files:** `core/scene3d/types.ts` (`board` gains `outline?: XZ[]` and `pitchMm: number`),
`core/scene3d/board.ts` (holes and pads from `existingHoles`; `outline` from `outlinePoints(…, EDGE_MARGIN_PITCH)`
when shaped), `core/scene3d/index.ts` (`sceneBounds` from the outline when present),
`app/utils/scene3dThree.ts` (slab: `extrudeGeometry(outline, -thickness, 0)` when `outline`, else today's box;
`labelMesh` uses `scene.board.pitchMm`); tests `tests/core/scene3d/*.test.ts` (board) and
`tests/app/scene3dThree.test.ts`.

- [ ] **Step 1: Failing tests** — a round 10 × 10 scene has `holes.length === existingHoles(...).length`, pads
  likewise, `board.outline` with ≥ 32 points, `board.pitchMm === 2.54`; a plain board has no `outline` and the
  same holes as today; the label size test passes for a board whose first two existing holes are not neighbours
  (Focus 5).
- [ ] **Step 2–4:** run → FAIL, implement, run `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(3d): shaped boards in the 3D view`

### Task 6: Make one — API, "New board", the CHOGORI preset

**Files:** `server/utils/api.ts` (`emptyBoard` passes `json.shape` through when present), `core/boardPresets.ts`
(`BoardPreset.shape?`; CHOGORI `shape: { kind: 'round' }`), `app/utils/newBoard.ts`
(`NewBoardDraft.shape: 'rect' | 'round' | 'chamfer' | 'notch'`, `cornerHoles: number`;
`shapeOf(d): BoardShape | undefined` — chamfer/notch apply to all four corners), `NewBoardModal.vue` (a Shape
select and, for corners, a "Corner size (holes)" number; disabled with a preset, which shows its own shape),
README / Connections route row (`shape` in the create body); tests in `tests/server/api.test.ts`,
`tests/core/boardPresets.test.ts`, `tests/app/newBoard.test.ts`.

- [ ] **Step 1: Failing tests** — `{ name, cols: 10, rows: 10, type, shape: { kind: 'round' } }` creates a round
  board; a bad shape is a 422 from `parseBoard`; the CHOGORI preset board has `shape.kind === 'round'` and all
  4 holes exist; `newBoardBody` for a Custom draft with `shape: 'notch', cornerHoles: 2` sends the four-corner
  notch shape, with `rect` sends no `shape`.
- [ ] **Step 2–4:** run → FAIL, implement, run `pnpm test`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Browser check** (scratch server, port 3125, own data dir): a Custom round 10 × 10 board shows a
  circle with no corner holes on both sides and in 3D; a notched 12 × 8 board shows notches (mirrored on the
  bottom); the pencil refuses a click where a hole is missing.
- [ ] **Step 6: Commit** `feat: make shaped boards (API, New board, round CHOGORI preset)`
