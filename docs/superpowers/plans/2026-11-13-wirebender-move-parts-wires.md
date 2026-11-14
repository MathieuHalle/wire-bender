# Moving parts and wires — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Move tool (key `M`) in the 2D editor that picks up a part, a whole wire or one wire end with a click, shows a copy snapped to the hole under the pointer (red where it can't go), rotates with `R` / `←` / `→`, bends laid-wire ends with an L (`Tab` flips it), and sets it down as one undoable edit.

**Architecture:** All rules are pure functions in a new `core/move.ts` (no Vue, no DOM), returning the moved board plus a refusal reason, so the preview copy and the click use the same answer. `app/composables/useTools.ts` holds the pick-up state and keys; `app/components/BoardSide.vue` and `app/components/board/*` draw the copy; the page shows the hint and the touch bar. A placement is one `deps.apply(board)`.

**Tech Stack:** TypeScript, Vue 3 / Nuxt 4, Vitest. Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

**Spec:** `docs/superpowers/specs/2026-11-13-wirebender-move-parts-wires-design.md` (approved 2026-11-13). Read it first.

## Global Constraints

- `core/` has no UI or Node deps: no Vue, Nuxt, Node `fs`, or DOM.
- The board format does not change (`wirebender/1`). A move rewrites only: a part's `at`, `to`, `rotation`, and the `to` of `legFolds` whose `lead` is `<ref>.<pin>` of that part; a wire's `points`, `joints`, `bareSegments`.
- Laid wires keep every step along a row or a column (`checkStraight` in `core/schema.ts`). Flying wires have no such rule.
- No joints are ever added by a move. Nothing but the held item changes.
- Refusals: a pin, a fold's `to`, or a wire point off the board; any of those on a blocked hole (reason text exactly as the pencil's: `Hole <name> is blocked: <reason>`); a **new** part-against-part conflict (body overlap, shared lead hole, lead under a body), where a conflict between the same two parts by the same rule that existed before the move does not count. A part body may hang over the board edge. Wires, trails and their findings never block.
- Locked boards (3D, not live, view role): no Move tool, no pick-ups (the existing `locked()` rule).
- One placement = one `apply` = one undo step.
- Findings stay advisory; nothing in this work claims a board is safe to power.
- **Flying wires have no drawn line** (`app/components/board/Wires.vue` draws only their end dots), so a flying wire is picked by an end only and moved end by end. Every laid wire, a 2-hole jumper included, can be picked whole by its line. (Spec: "click anywhere else on the wire"; a flying wire has nowhere else.)

## Review Focus

1. **A remote edit while holding** (the iPad changes or deletes the held part): the pick is dropped with `<ref> was changed on another device; pick it up again.` (wire: `Wire <id> ...`), never placed over the newer board. Test in Task 4.
2. **Undo while holding:** Ctrl/Cmd+Z while something is held first drops the pick (as Esc), then undoes; the copy never outlives the item. Test in Task 4.
3. **Switching tool or view while holding** (a tool key, `3` for 3D, `F`): the pick is dropped with no change. Tool switch: test in Task 4; view switch: the page calls `cancel()` (Task 5) and the browser check covers it.
4. **Tab while not holding a laid-wire end** keeps the browser's focus behaviour (no `preventDefault`); only a held laid-wire end swallows Tab. Test in Task 4.
5. **A part with `to` omitted** (a two-lead part at its minimum span) rotated: `to` is written explicitly, and the result passes `parseBoard`. Test in Task 1.

---

### Task 1: `core/move.ts`: the placement transform and moving a part

**Files:**
- Create: `core/move.ts`
- Modify: `core/check/placement.ts` (export `OVERLAP_TOLERANCE_MM`)
- Test: `tests/core/move.test.ts`

**Interfaces:**
- Consumes: `placePart`, `rotateOffset`, `FOOTPRINTS` (`core/footprints.ts`); `parseHole`, `holeName`, `holeKey` (`core/holes.ts`); `BoardFile` (`core/schema.ts`).
- Produces:
  - `export type Turns = 0 | 1 | 2 | 3` (quarter turns clockwise on screen, as `rotateOffset` turns)
  - `export interface Placement { from: Hole, to: Hole, turns: Turns }`: the grabbed hole `from` lands on `to`, then everything turns `turns` times about `to`.
  - `export function mapHole(h: Hole, p: Placement): Hole`: `to + rotateOffset(h - from, 90 * turns)`.
  - `export interface MoveResult { board: BoardFile, reason: string | null }`: `board` is always the moved board (the preview draws it, red when `reason` is set); only `reason === null` may be applied.
  - `export function movePart(board: BoardFile, ref: string, p: Placement): MoveResult`

- [ ] **Step 1: Write the failing tests** in `tests/core/move.test.ts`, using `mk` and `axial` from `tests/core/helpers.ts` and `H = parseHole`. Freeze inputs (the `deepFreeze` helper as in `edit.test.ts`) so a mutation fails.

```ts
it('moves a part: the grabbed hole lands on the target', () => {
  const b = mk({ parts: [axial('R1', 'B2', 'B5', 'N1')] })
  const r = movePart(b, 'R1', { from: H('B2'), to: H('E3'), turns: 0 })
  expect(r.reason).toBeNull()
  expect(r.board.parts[0]).toMatchObject({ at: 'E3', to: 'E6' })
})
it('rotates a two-lead part about the grabbed hole', () => {
  const r = movePart(mk({ parts: [axial('R1', 'B2', 'B5', 'N1')] }), 'R1', { from: H('B2'), to: H('B2'), turns: 1 })
  expect(r.board.parts[0]).toMatchObject({ at: 'B2', to: 'E2', rotation: 0 })
})
it('writes `to` when a two-lead part without one is rotated', () => {
  // the same axial with `to` deleted: it sits at its minimum span
  // expect r.board.parts[0].to to be defined, and parseBoard(r.board).ok to be true
})
it('adds the turns to `rotation` for other footprints', () => {
  // dip8 U1 at C3 rotation 0, turns 1 -> rotation 90; turns 3 from 270 -> 180
})
it('moves and turns the part\'s own leg folds with it', () => {
  const b = mk({ parts: [axial('R1', 'B2', 'B5', 'N1')], legFolds: [{ lead: 'R1.a', to: 'C2' }] })
  expect(movePart(b, 'R1', { from: H('B2'), to: H('E3'), turns: 0 }).board.legFolds).toEqual([{ lead: 'R1.a', to: 'F3' }])
  // another part's fold is left as it is
})
it('refuses a pin off the board, and still returns the moved board', () => {
  const r = movePart(mk({ parts: [axial('R1', 'B2', 'B5', 'N1')] }), 'R1', { from: H('B2'), to: H('B9'), turns: 0 })
  expect(r.reason).toBe('R1 would be off the board.')
  expect(r.board.parts[0]!.at).toBe('B9')
})
it('lets a body hang over the edge when every pin is on the board', () => { /* a part whose body rect passes col 10 with pins inside: reason null */ })
it('refuses a pin or a fold on a blocked hole, with the hole\'s reason', () => {
  // blocked: [{ holes: ['E6'], reason: 'screw' }] -> 'Hole E6 is blocked: screw'
})
it('refuses a new shared lead hole', () => { /* R1 pin onto R2 pin hole -> 'R1 would share hole <name> with R2.' */ })
it('refuses landing over another part\'s leg, or a leg under another body', () => {
  // dip8 U1 body; R1 pin onto a U1 body hole -> 'A leg of R1 would be under U1.'
  // move U1 so its body covers R2's pin -> 'U1 would sit over a leg of R2.'
})
it('refuses a new body overlap', () => { /* two dip8 bodies -> 'U2 would overlap U1.' */ })
it('allows a conflict the board already had (same two parts, same rule)', () => {
  // U1 and U2 already overlapping; nudge U2 one hole, still overlapping -> reason null
})
it('adds no joints and changes no wiring when a part lands on a trail', () => {
  // trail('T1', ['E2', 'E8']) under the target pins: r.board.trails and wires toEqual the input's
})
it('answers "No part X." for an unknown ref', () => {})
```

- [ ] **Step 2: Run** `pnpm vitest run tests/core/move.test.ts`. Expected: FAIL, `core/move.ts` not found.

- [ ] **Step 3: Implement** `Turns`, `Placement`, `mapHole`, `MoveResult`, `movePart` in `core/move.ts`, and export `OVERLAP_TOLERANCE_MM` from `core/check/placement.ts`.
  - The part's `at` and `to` (for a twoLead footprint without `to`, first make it explicit: `at` + `minSpan` columns, as `placePart` does) go through `mapHole`. Non-twoLead footprints get `rotation = (rotation + 90 * turns) % 360`; twoLead parts keep `rotation` (their direction is `at`→`to`).
  - Folds: every `legFolds` entry whose `lead` starts with `<ref>.` gets `to = mapHole(to)`.
  - Checks, in this order, first reason wins: pins and fold `to`s off the board → `<ref> would be off the board.`; on a blocked hole → `Hole <name> is blocked: <reason>`; then conflicts.
  - Conflicts: a private `partConflicts(board, ref): Set<string>` keyed `<rule>|<other ref>` over `placePart` of every part: `shared` (a pin hole equal to another part's pin hole), `under` (a pin in another part's `bodyHoles`), `over` (another part's pin in this part's `bodyHoles`), `overlap` (body rects overlap by more than `OVERLAP_TOLERANCE_MM` in both axes, as `bodyCollision` does). Refuse only keys in the after-set and not in the before-set. Messages: `<ref> would share hole <name> with <other>.`, `A leg of <ref> would be under <other>.`, `<ref> would sit over a leg of <other>.`, `<ref> would overlap <other>.`

- [ ] **Step 4: Run** `pnpm vitest run tests/core/move.test.ts`, then `pnpm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add core/move.ts core/check/placement.ts tests/core/move.test.ts
git commit -m "feat(core): move a part (placement transform, refusals, leg folds)"
```

---

### Task 2: `core/move.ts`: moving a whole wire and one wire end

**Files:**
- Modify: `core/move.ts`
- Test: `tests/core/move.test.ts`

**Interfaces:**
- Consumes: `Placement`, `mapHole`, `MoveResult` (Task 1); `pathHoles` (`core/holes.ts`).
- Produces:
  - `export function moveWire(board: BoardFile, id: string, p: Placement): MoveResult`
  - `export type WireEnd = 'first' | 'last'`
  - `export type Bend = 'row-first' | 'col-first'`
  - `export function moveWireEnd(board: BoardFile, id: string, end: WireEnd, target: Hole, bend: Bend): MoveResult`

- [ ] **Step 1: Write the failing tests** (a `wire(id, points, opts)` helper in the test file builds a laid or flying wire with `bareSegments: []`, `joints: []` by default).

```ts
it('moves a whole laid wire with its shape, joints and bare stretches', () => {
  // W1 laid ['B2','B5','D5'], joints ['B5'], bare [1]; from B2 to C3, turns 0
  // -> points ['C3','C6','E6'], joints ['C6'], bareSegments [1], reason null
})
it('turns a whole wire about the grabbed hole and keeps it straight', () => {
  // turns 1; parseBoard(r.board).ok is true
})
it('refuses a wire point off the board or on a blocked hole', () => {
  // 'Wire W1 would be off the board.' / 'Hole <name> is blocked: <reason>'
})
it('lengthens or shortens a laid wire when the new end is in line', () => {
  // ['B2','B5'] last -> 'B7' gives ['B2','B7']
})
it('adds one corner, row first, then column first with Tab', () => {
  const b = mk({ wires: [wire('W1', ['B2', 'B5'])] })
  expect(moveWireEnd(b, 'W1', 'last', H('E7'), 'row-first').board.wires[0]!.points).toEqual(['B2', 'B7', 'E7'])
  expect(moveWireEnd(b, 'W1', 'last', H('E7'), 'col-first').board.wires[0]!.points).toEqual(['B2', 'E2', 'E7'])
})
it('moves the first end too, shifting bare segment numbers', () => {
  // ['B2','B5','E5'] bare [1]; first -> 'D3' row-first -> points ['D3','B3','B5','E5'], bareSegments [2]
})
it('the two runs of the L are bare when the run they replace was bare', () => {
  // ['B2','B5'] bare [0]; last -> 'E7' -> bareSegments [0, 1]
})
it('the end joint moves with the end; joints the wire no longer reaches are dropped', () => {
  // ['B2','B8'] joints ['B8','B6'], last -> 'B4' -> joints ['B4']
})
it('refuses an end landing on the point before it', () => {
  // ['B2','B5'] last -> 'B2' -> 'The end can\'t land on the point before it.'
})
it('moves a flying wire end anywhere, but not onto its other end', () => {
  // flying ['B2','H9'] last -> 'C4' -> ['B2','C4']; last -> 'B2' -> 'Both ends of wire W1 would be in B2.'
})
it('refuses a new end on a blocked hole', () => {})
it('answers "No wire X." for an unknown id', () => {})
```

- [ ] **Step 2: Run** `pnpm vitest run tests/core/move.test.ts`. Expected: the new tests FAIL (`moveWire` not exported).

- [ ] **Step 3: Implement** `moveWire` and `moveWireEnd`.
  - `moveWire`: `points` and `joints` through `mapHole`; `bareSegments` unchanged. Checks: any point off the board → `Wire <id> would be off the board.`; any point on a blocked hole → the blocked reason.
  - `moveWireEnd`: `prev` is the point next to the moved end. Laid: target equal to `prev` → refuse; in line with `prev` → replace the end; else insert the corner between `prev` and the end: row-first corner `{ col: target.col, row: prev.row }`, col-first `{ col: prev.col, row: target.row }`. Bare: both new runs take the replaced run's flag; when the corner is inserted at the first end every other index shifts by one. Flying: replace the end; equal to the other end → refuse. Joints: if the old end was a joint it becomes `target`; then drop every joint not on `pathHoles(newPoints)`. The target on a blocked hole → the blocked reason.

- [ ] **Step 4: Run** `pnpm vitest run tests/core/move.test.ts`, then `pnpm test`. Expected: all PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(core): move a whole wire, or one end with an L-bend"`

---

### Task 3: `core/move.ts`: what a click picks up

**Files:**
- Modify: `core/move.ts`
- Test: `tests/core/move.test.ts`

**Interfaces:**
- Produces:
  - `export type Pick = { kind: 'part', ref: string, at: Hole } | { kind: 'wire', id: string, at: Hole } | { kind: 'wire-end', id: string, end: WireEnd, at: Hole }` (`at`: the grabbed hole, the `from` of the later `Placement`)
  - `export function pickAt(board: BoardFile, side: Side, point: { col: number, row: number }): Pick | null`: `point` is fractional hole coordinates, the `{ fc, fr }` of `BoardSide`'s `boardPoint` (holes at whole numbers, already unmirrored).

- [ ] **Step 1: Write the failing tests**

```ts
it('an end hole picks that end', () => { /* laid W1 ['B2','B6'] on bottom, point {col:6,row:2} -> wire-end last, at B6 */ })
it('a hole the wire passes picks the whole wire', () => { /* point {col:4,row:2} -> wire, at B4 */ })
it('the line of a 2-hole jumper picks the whole wire', () => { /* ['B2','B3'], point {col:2.5,row:2} -> wire, at B2 */ })
it('a flying wire is picked by its ends only', () => { /* flying ['B2','H9']: {col:2,row:2} -> wire-end first; {col:5,row:5} -> null */ })
it('parts are picked on the top side only', () => { /* axial R1 B2-B5: top {col:3,row:2} -> part at B3; bottom -> null */ })
it('a wire drawn over a part wins', () => { /* a top laid wire over R1's body hole -> wire */ })
it('only items of the given side', () => { /* a bottom wire is not picked on top */ })
it('empty board -> null', () => {})
```

- [ ] **Step 2: Run** `pnpm vitest run tests/core/move.test.ts`. Expected: new tests FAIL.

- [ ] **Step 3: Implement `pickAt`.** Order: wire ends (`point` within 0.35 hole of an end of a wire on `side`; the last such wire in `board.wires` wins, as it is drawn last), then laid-wire lines (distance from `point` to a segment of a laid wire on `side` ≤ 0.3 hole; `at` is the nearest hole on that wire's path), then, on `top` only, parts (the nearest hole is a pin or a `bodyHoles` entry of `placePart`, or `point` is inside `bodyRectMm` converted with `holeMm`; `at` is the nearest hole; the last part wins).

- [ ] **Step 4: Run** `pnpm vitest run tests/core/move.test.ts` and `pnpm test`. Expected: all PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(core): pickAt, what a Move click picks up"`

---

### Task 4: the Move tool in `useTools`

**Files:**
- Modify: `app/utils/boardView.ts` (`Tool` gains `'move'`; the `KEYS` text lives in the page)
- Modify: `app/composables/useTools.ts`
- Modify: `app/components/EditPanel.vue` (`TOOLS` gains `{ id: 'move', label: 'Move', icon: 'i-lucide-move', key: 'M' }` after Joint)
- Modify: `app/pages/b/[id].vue` (`KEYS` becomes `H: navigate (drag pans) · I P E J M: tools · M then click: pick up, R ← →: rotate, Tab: bend, Esc: put back · …`, the rest unchanged)
- Test: `tests/app/useTools.test.ts`, `tests/app/pageKeys.test.ts`

**Interfaces:**
- Consumes: `pickAt`, `movePart`, `moveWire`, `moveWireEnd`, `Pick`, `Placement`, `Turns`, `Bend`, `MoveResult` (Tasks 1–3).
- Produces, on the object `createTools` returns:
  - `held: Ref<Held | null>` with `export interface Held { pick: Pick, side: Side, target: Hole, turns: Turns, bend: Bend, snapshot: string }` (`snapshot`: `JSON.stringify` of the held part or wire at pick-up)
  - `preview: ComputedRef<MoveResult | null>`: the result for `held` at its `target`, or null
  - `onMoveClick(side: Side, point: { col: number, row: number }): void`: not holding → `pickAt`, and on a pick `held` starts with `target = pick.at`, `turns 0`, `bend 'row-first'`. Holding → the nearest hole: if it equals `target`, place; else move `target` there (touch: first tap previews, second places; with a mouse, `onHover` has already set `target`, so one click places).
  - `onMoveHover(side: Side, hole: Hole | null): void`: while holding on that side, `target = hole` when not null.
  - `rotate(dir: 1 | -1): void`, `switchBend(): void`, `place(): void`, `cancel(): void` (for the touch bar).
- `TOOL_KEYS` gains `m: 'move'`. In `onKeydown`, while `held`: `r` and `ArrowRight` → `rotate(1)`, `ArrowLeft` → `rotate(-1)` (only for `part` and `wire` picks), `Tab` → `switchBend()` with `preventDefault()` only for a held end of a laid wire, `Escape` → `cancel()`.
- Placing: `preview.reason === null` → `deps.apply(preview.board)`, `held = null`; otherwise `notify(reason)` and keep holding.

- [ ] **Step 1: Write the failing tests** in `tests/app/useTools.test.ts`, with the existing fake deps (`board` ref, `apply` spy, `notify` spy).

```ts
it('M picks the Move tool; a click picks up, a second click on the same hole places', () => {})
it('hover moves the target; the click there places in one apply', () => {})
it('R and → turn clockwise, ← counter-clockwise; ignored for a wire end', () => {})
it('Tab flips the bend only for a held laid-wire end, and only then prevents default', () => {})
it('a refused spot notifies the reason and keeps holding; nothing is applied', () => {})
it('Esc puts it back: no apply, held is null', () => {})
it('a remote change to the held item drops it with "<ref> was changed on another device; pick it up again."', () => {})
it('a remote deletion of the held item drops it too', () => {})
it('Ctrl/Cmd+Z while holding drops the pick, then undoes', () => {})
it('switching tool drops the pick without applying', () => {})
it('locked: no pick-up, and M does not select Move', () => {})
```

And in `tests/app/pageKeys.test.ts`, add `'m'` and `'M'` to the "tool keys are not page keys" list, and check `'r'`, `'ArrowLeft'`, `'ArrowRight'`, `'Tab'` are not page keys either.

- [ ] **Step 2: Run** `pnpm vitest run tests/app/useTools.test.ts tests/app/pageKeys.test.ts`. Expected: new tests FAIL.

- [ ] **Step 3: Implement** in `useTools.ts`, `boardView.ts`, `EditPanel.vue`, the page's `KEYS`. Remote change: a `watch(deps.board)` (sync) compares `snapshot` with the held item now; differs or gone → `held = null` and `notify('<ref> was changed on another device; pick it up again.')` (for wires `Wire <id> was changed …`). The `watch(tool)` that ends drawings also drops `held`. Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z while holding call `cancel()` before `deps.undo()` / `deps.redo()`. `blindHint` in `boardView.ts` covers Move like Inspect (components and wires layers).

- [ ] **Step 4: Run** `pnpm vitest run tests/app` then `pnpm test` and `pnpm typecheck`. Expected: all PASS, no type errors.

- [ ] **Step 5: Commit** `git commit -m "feat(app): the Move tool (M): pick up, rotate, bend, place, Esc"`

---

### Task 5: drawing the copy, the hint and the touch bar

**Files:**
- Modify: `app/components/BoardSide.vue`
- Modify: `app/components/board/Parts.vue`, `app/components/board/Wires.vue` (dim one item, tint one item)
- Modify: `app/pages/b/[id].vue`
- Create: `app/utils/moveHint.ts`
- Test: `tests/app/moveHint.test.ts`

**Interfaces:**
- Consumes: `held`, `preview`, `onMoveClick`, `onMoveHover`, `rotate`, `switchBend`, `place`, `cancel` (Task 4).
- Produces:
  - `BoardSide` prop `moving?: { board: BoardFile, key: string, ok: boolean } | null` (`key` is `part:<ref>` or `wire:<id>`, the format of `hidden`): when set, the side draws `props.board` with the item `key` dimmed (opacity 0.35) and, over it, that item from `moving.board`, normal when `ok`, red (`#e5484d`) when not.
  - `BoardSide` emits `point-click: [point: { col: number, row: number }]` when `tool === 'move'` (instead of `hole-click`); `hover` as today.
  - `export function moveHint(held: Held | null, preview: MoveResult | null): string | null` in `app/utils/moveHint.ts`: null when not holding; `Moving R3: click to place, R to rotate, Esc to put back` (a part or a whole wire: `Moving wire W2: …`); a laid-wire end: `Moving the end of wire W2: click to place, Tab to switch the bend, Esc to put back`; when `preview.reason` is set, the reason, then ` · Esc to put back`.

- [ ] **Step 1: Write the failing tests** in `tests/app/moveHint.test.ts`: the four texts above, exactly.

- [ ] **Step 2: Run** `pnpm vitest run tests/app/moveHint.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `moveHint`; the `moving` prop and `point-click` in `BoardSide`; in the page, pass `moving` to each side (only the held item's side shows the copy), route `point-click` and `hover` to the tools, call `cancel()` when the view changes (2D both / top / bottom / 3D), show `moveHint` where the drawing hint goes today (`hint` computed: drawing first, else the move hint, else nothing), and show a small bar while holding on touch devices (`(pointer: coarse)`): **Rotate** (`rotate(1)`, parts and whole wires), **Switch bend** (laid-wire ends), **Place** (disabled while `preview.reason` is set), **Cancel**, as `UButton`s, `size="sm"`, over the canvas's bottom edge.

- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm lint`. Expected: all PASS.

- [ ] **Step 5: Browser check** on a local-mode test server with its own data folder (a git worktree under `.claude/worktrees/`, `WIREBENDER_DATA=$PWD/.data PORT=3002`, never the owner's 3001 server or its data). On a two-sided board made through the API, with a dip8, two axials, a laid wire with a bend and joints, a 2-hole jumper and a flying wire:
  - part: pick, follow, rotate R / ← / →, red over another part with the reason in the hint, place, Ctrl/Cmd+Z restores it;
  - laid wire: pick by its line, move, rotate, place; jumper picked whole by its line;
  - laid end: L row-first, Tab, col-first, place; a shortened end drops its joint in the copy before the click;
  - flying end: anywhere; onto its other end is red;
  - Esc puts back; switching to Pencil while holding puts back;
  - a second tab on the same board sees each placement live; editing the held part in the second tab drops the pick in the first, with the message;
  - with the window at touch emulation (DevTools device mode): the bar shows, tap previews, Place sets.
  Record what was checked in the commit message.

- [ ] **Step 6: Commit** `git commit -m "feat(app): the Move copy on the board, its hint, and the touch bar"`
