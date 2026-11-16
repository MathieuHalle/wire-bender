# Move tool follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the seven Move tool follow-ups noted in `docs/backlog.md` after the v0.2.0 reviews.

**Architecture:** Rules stay in `core/move.ts` (refusals, the copy's placement). The copy, the
hover snapping and the touch bar's state move out of the components into small pure functions in
`app/utils/`, so they are tested in Node like the rest (the repo has no component tests). The
components and the page only call them.

**Tech Stack:** TypeScript, Vue 3 / Nuxt 4, Vitest (Node environment).

**Spec:** `docs/superpowers/specs/2026-11-13-wirebender-move-parts-wires-design.md` (the Move
tool). Owner decisions for this plan (2026-11-16): a laid-wire end that would run back over its
own wire is **refused**; the other fixes as proposed in the session (below, per task).

## Global Constraints

- `core/` has no Vue, Nuxt, Node or DOM imports.
- The board format does not change (`wirebender/1`).
- Anti-goal (spec): a placement that differs from the copy shown at the moment of the click.
  Every refusal keeps `MoveResult.reason` non-null; only `reason === null` is ever applied.
- Only **new** conflicts refuse (spec: "Only new conflicts count"); the same holds for the new
  self-overlap rule.
- Verification: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## Review Focus

1. A wire the API already drew over itself (an existing self-overlap) must still be movable by
   its end: only overlap the move adds is refused. Test in Task 1.
2. The copy of a part moved past the **top-left corner** and turned (both offsets negative,
   `turns` 1 to 3) is drawn under the pointer, turned the same way as an allowed copy. Test in
   Task 2 (mirrored geo included).
3. In the Move tool, a pointer just outside the board's edge must not snap the copy onto an
   off-board hole (the copy would jump past the edge). Test in Task 3 (`hoverHole` → `null`).
4. On the iPad, Cancel stays usable while reconnecting (putting back changes nothing). Test in
   Task 5 (`moveBar` paused: the bar is still shown; the page never disables Cancel).
5. A part picked on the **top** with a fold: the fold's copy is on the **bottom**, though the
   bottom is not the held side (moves and hovers there still do nothing). Test in Task 4
   (`moveSides`).

---

### Task 1: Refuse a laid-wire end that runs back over its own wire (item 3)

**Files:**
- Modify: `core/move.ts` (`moveWireEnd`)
- Test: `tests/core/move.test.ts` (`describe('moveWireEnd')`)

**Interfaces:**
- Produces: the reason string `Wire ${id} would run back over itself.`; the refused result's
  `board` is the **moved** board (so the copy is drawn where it would land, see Task 2).

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses an end moved back along its own run, or a corner that retraces it', () => {
  const b = frozen({ wires: [wire('W1', ['B2', 'B5', 'E5'])] })
  // Shortening the last run is not running back over the wire:
  expect(moveWireEnd(b, 'W1', 'last', H('C5'), 'row-first').reason).toBeNull()
  // In line with B5 but back over B2..B5:
  const back = moveWireEnd(b, 'W1', 'last', H('B3'), 'row-first')
  expect(back.reason).toBe('Wire W1 would run back over itself.')
  expect(back.board.wires[0]!.points).toEqual(['B2', 'B5', 'B3'])
  // A corner whose first run retraces B2..B5 (row first from B5 towards column 3):
  expect(moveWireEnd(b, 'W1', 'last', H('D3'), 'row-first').reason).toBe('Wire W1 would run back over itself.')
  // The same target, column first, does not retrace:
  expect(moveWireEnd(b, 'W1', 'last', H('D3'), 'col-first').reason).toBeNull()
})

it('refuses the first end running back over the wire too', () => {
  const b = frozen({ wires: [wire('W1', ['B2', 'B5', 'E5'])] })
  // D5 is in line with B5: the new first run D5..B5 lies on B5..E5.
  expect(moveWireEnd(b, 'W1', 'first', H('D5'), 'row-first').reason).toBe('Wire W1 would run back over itself.')
  expect(moveWireEnd(b, 'W1', 'first', H('B7'), 'row-first').reason).toBeNull()
})

it('a wire that already ran over itself can still be moved by its end', () => {
  // B2..B6 then back to B4: an existing overlap (drawn through the API).
  const b = frozen({ wires: [wire('W1', ['B2', 'B6', 'B4', 'E4'])] })
  expect(moveWireEnd(b, 'W1', 'last', H('G4'), 'row-first').reason).toBeNull()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/core/move.test.ts -t "back over"`
Expected: FAIL (reason is `null` where a refusal is expected).

- [ ] **Step 3: Implement in `moveWireEnd`**

After `points` is built (laid wires only), compare unit steps: the multiset of hole-to-hole steps
of `pathHoles(points)` (undirected, keyed by the two `holeKey`s sorted) against the same for the
old `wire.points`. If any step occurs more often in the new points than in the old ones, refuse
with `{ board: moved, reason }`. Check it before the off-board and blocked checks only if the
target is on the board (the off-board check keeps priority). Flying wires are not checked.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/core/move.test.ts`
Expected: PASS, all `move.test.ts` tests.

- [ ] **Step 5: Commit**

```bash
git add core/move.ts tests/core/move.test.ts
git commit -m "fix(core): a laid wire's end may not run back over the wire"
```

### Task 2: Draw a refused copy under the pointer (item 4)

**Files:**
- Modify: `core/move.ts` (`MoveResult`, `movePart`, `moveWire`, `moveWireEnd`)
- Create: `app/utils/moveCopy.ts`
- Modify: `app/components/BoardSide.vue` (the `copy` computed and the copy `<g>`)
- Test: `tests/core/move.test.ts`, `tests/app/moveCopy.test.ts`

**Interfaces:**
- Produces (core): `MoveResult` gains `ghost?: Placement`. Set only when the moved board cannot be
  written (a part or a whole wire pushed past the top or left edge): `board` is then unmoved and
  the copy is the **original** item drawn through `ghost`. The two wire-end refusals (onto the
  point before it; both flying ends in one hole) now return the **moved** board, like every other
  refusal. Update `MoveResult`'s doc comment to say exactly this.
- Produces (app): `ghostTransform(geo: Pick<Geo, 'pt'>, p: Placement): string` — an SVG
  `matrix(a b c d e f)` that maps `geo.pt(h)` to `geo.pt(mapHole(h, p))` for every hole `h`
  (an affine map built from `p.from`, `p.from` + 1 column, `p.from` + 1 row; works mirrored).
- Produces (app): `export interface Moving { board: BoardFile, key: string, ok: boolean, ghost?: Placement, folds?: boolean }`
  (BoardSide's `moving` prop takes `Moving | null`; `folds` is used from Task 4).
- Produces (app): `moveCopy(moving: Moving | null): { board: BoardFile, placed: PlacedPart[], tint: string | null, ghost: Placement | null, folds: boolean } | null`
  — the body of today's `copy` computed (`REFUSED = '#e5484d'` moves with it), plus `ghost`.

- [ ] **Step 1: Write the failing tests**

Core: a part moved so a pin is left of column 1 → `reason` `R1 would be off the board.`,
`board` unmoved, `ghost` equal to the placement; same for `moveWire`. `moveWireEnd` onto the
point before it → `board.wires[0].points` equal to `['B2', 'B2']`; flying both ends in B2 →
`['B2', 'B2']`; neither has `ghost`. Allowed moves have no `ghost`.

App (`moveCopy.test.ts`): with a fake `geo` (`pt: h => ({ x: h.col * 2, y: h.row * 2 })`) and a
mirrored one (`x: -h.col * 2`): applying the parsed matrix of `ghostTransform` to `geo.pt(h)`
gives `geo.pt(mapHole(h, p))` for `h` = from, a far hole, and a negative-offset hole, for
`turns` 0 to 3. `moveCopy` of a refused part move returns `tint` `#e5484d` and only that part;
of an allowed one `tint` `null`; `ghost` passed through.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/core/move.test.ts tests/app/moveCopy.test.ts`
Expected: FAIL (`ghost` undefined; module `moveCopy` not found).

- [ ] **Step 3: Implement** the core changes, `app/utils/moveCopy.ts`, and in `BoardSide.vue`
replace the `copy` computed with `moveCopy(props.moving)` and wrap the copy `<g>`'s content in
`<g :transform="copy.ghost ? ghostTransform(geo, copy.ghost) : undefined">`. In
`app/pages/b/[id].vue` (`moving`), pass `ghost: r.ghost`. Add `ghost?: Placement` to
BoardSide's `moving` prop type.

- [ ] **Step 4: Run** `pnpm test` → PASS; `pnpm typecheck` → no errors.

- [ ] **Step 5: Commit** `fix(app,core): a refused Move copy is drawn where it would land`

### Task 3: A click in a diagonal gap places where the copy is (item 2)

**Files:**
- Modify: `app/utils/movePointer.ts`
- Modify: `app/components/BoardSide.vue` (`holeAt` use in `track`)
- Test: `tests/app/movePointer.test.ts`

**Interfaces:**
- Produces: `hoverHole(fc: number, fr: number, cols: number, rows: number, snapAll: boolean): Hole | null`.
  `snapAll` false: today's `holeAt` (nearest hole within 0.5, on the board). `snapAll` true: the
  nearest hole by `Math.round`, clamped to nothing (null) only when it is off the board — the
  same hole `onMoveClick` rounds a click to.

- [ ] **Step 1: Write the failing tests**

```ts
it('outside the Move tool a diagonal gap has no hole', () => {
  expect(hoverHole(2.3, 3.3, 10, 10, false)).toEqual({ col: 2, row: 3 })
  expect(hoverHole(2.4, 3.6, 10, 10, false)).toBeNull() // 0.4² + 0.4² > 0.5²
})
it('in the Move tool the gap snaps to the hole a click rounds to', () => {
  expect(hoverHole(2.4, 3.6, 10, 10, true)).toEqual({ col: 2, row: 4 })
  expect(hoverHole(0.4, 3, 10, 10, true)).toBeNull() // rounds to column 0: off the board
})
```

- [ ] **Step 2: Run** `pnpm vitest run tests/app/movePointer.test.ts` → FAIL (`hoverHole` not exported).

- [ ] **Step 3: Implement** `hoverHole`; in `BoardSide.vue` `track`, use
`hoverHole(p.fc, p.fr, geo.cols, geo.rows, props.tool === 'move')` for the hover (and drop the
local `holeAt` if nothing else uses it; `onClick` keeps the 0.5 rule for the other tools via
`hoverHole(..., false)`). Picking is unchanged: `onMoveClick` still receives the fractional point.

- [ ] **Step 4: Run** `pnpm test` → PASS.

- [ ] **Step 5: Commit** `fix(app): in the Move tool the hover snaps like the click`

### Task 4: Draw a moved part's leg folds in the copy (item 1)

**Files:**
- Modify: `app/pages/b/[id].vue` (`moving`)
- Modify: `app/utils/moveCopy.ts`, `app/components/BoardSide.vue` (copy `<g>`)
- Modify: `app/components/board/Copper.vue` (a `tint` prop for its folds, as Parts and Wires have)
- Test: `tests/app/moveCopy.test.ts`

**Interfaces:**
- Consumes: `moveCopy` (Task 2).
- Produces: `moveSides(held: Held | null, preview: MoveResult | null): Record<Side, Moving | null>`
  in `app/utils/moveCopy.ts`, replacing the page's `moving` computed body. A held **part** gives
  the picked side its copy as today **and** the bottom side `{ ..., folds: true }` when the part
  has leg folds; wires are unchanged. `moveCopy` with `folds: true` returns a board holding only
  the part and its folds, drawn by `BoardCopper` (folds only: `trails`, `bridges` and wires empty)
  with the tint.

- [ ] **Step 1: Write the failing tests** — `moveSides` for a held part with a fold: top has
`key 'part:R1'`, bottom has `folds: true` and the moved fold's `to`; a part without folds: bottom
`null`; a held wire: only its side. `moveCopy` with `folds: true`: `board.legFolds` only R1's, the
moved `to`.

- [ ] **Step 2: Run** `pnpm vitest run tests/app/moveCopy.test.ts` → FAIL.

- [ ] **Step 3: Implement** `moveSides`, the `folds` branch of `moveCopy`, Copper's `tint`, and
render `<BoardCopper>` in BoardSide's copy `<g>` when `copy.folds`. Bottom-side dimming of the
original folds is out of scope (the original stays drawn, as the spec says).

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** `fix(app): a moved part's leg folds show in the copy`

### Task 5: The touch bar is disabled while reconnecting (item 5)

**Files:**
- Create: `app/utils/moveBar.ts`
- Modify: `app/pages/b/[id].vue` (`moveBar` computed, the bar's buttons)
- Test: `tests/app/moveBar.test.ts`

**Interfaces:**
- Produces: `moveBar(opts: { coarse: boolean, held: Held | null, preview: MoveResult | null, lockedTitle: string | null, pausedTitle: string, board: BoardFile | null }): { rotate: boolean, bend: boolean, canPlace: boolean, paused: boolean } | null`
  — today's computed body plus `paused`. The page binds `:disabled="moveBar.paused"` on Rotate
  and Switch bend, and `:disabled="!moveBar.canPlace || moveBar.paused"` on Place; Cancel is
  never disabled.

- [ ] **Step 1: Write the failing tests** — not coarse → `null`; locked (not paused) → `null`;
paused → `paused: true`, bar still shown; a laid-wire end → `bend: true, rotate: false`; a part →
`rotate: true, bend: false`; `canPlace` follows `preview.reason === null`.

- [ ] **Step 2: Run** `pnpm vitest run tests/app/moveBar.test.ts` → FAIL.

- [ ] **Step 3: Implement** and use it in the page.

- [ ] **Step 4: Run** `pnpm test` → PASS.

- [ ] **Step 5: Commit** `fix(app): the Move touch bar is disabled while reconnecting`

### Task 6: Measure `partConflicts` on the biggest board (item 6)

**Files:**
- Test: `tests/core/move.test.ts` (a timing test) — only if Step 2 says it is needed
- Modify: `core/move.ts` — only if Step 2 says it is needed

- [ ] **Step 1: Measure** — in a scratch script (not committed), load the largest board on the
owner's local server (`GET http://localhost:3001/api/boards`, pick the most parts) and time
`movePart` for each part to 3 targets (median of 20 runs).

- [ ] **Step 2: Decide** — under 4 ms per call (a quarter of a 60 Hz frame): no cache; write the
number in the backlog item's removal note (commit message). Over: cache the "before" set per
`(board object, ref)` in a `WeakMap` and add a test that a second call returns the same reason.

- [ ] **Step 3: Commit** (only if code changed) `perf(core): cache a part's existing conflicts per board`

### Task 7: The missing tests (item 7) and the backlog

**Files:**
- Test: `tests/core/move.test.ts`, `tests/app/movePointer.test.ts`
- Modify: `docs/backlog.md`

- [ ] **Step 1: Add tests** (they should pass at once; any failure is a bug to fix in `core/move.ts`):
  - `pickAt`: a click inside a part's body rectangle but on no hole picks the part; a wire end and
    a wire line both in reach → the end wins; two parts overlapping → the later one in
    `board.parts` wins; two wires' ends in reach → the later wire wins.
  - `moveWireEnd`: the first end's joint moves with it; a target past the right or bottom edge →
    `Wire W1 would be off the board.` with the moved board.
- [ ] **Step 2: Run** `pnpm test`, `pnpm typecheck`, `pnpm lint` → all pass.
- [ ] **Step 3: Remove** the "Move tool follow-ups" section from `docs/backlog.md`, noting in the
commit body what was left out: the page wiring of `pickableBoard` (one line; covered by the
browser check) and component tests (the logic moved to tested `app/utils/` functions instead).
- [ ] **Step 4: Browser check** on a scratch server (own worktree, own data dir, port 3125, local
mode) with a test board: a click in a diagonal gap places; a part moved past the top-left edge
shows the red copy under the pointer; a part with a leg fold shows the fold's copy on the bottom;
a laid end dragged back over its wire is red with "Wire … would run back over itself."
- [ ] **Step 5: Commit** `docs(backlog): Move tool follow-ups done` with the notes above.
