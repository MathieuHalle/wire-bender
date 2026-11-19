# Strips and breadboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release 1 of the strips design: built-in copper strips in `wirebender/1`, worked into
connectivity, the checks, 2D, 3D and the bench sheet; and the breadboard (a board type with nothing
soldered, jumpers, printed row names, three presets) as their first user.

**Architecture:** `board.strips` (straight `{ from, to }` runs) is read by one new module,
`core/strips.ts`. Connectivity adds a `strip` conductor that joins the bottom pad of each of its
holes; on a breadboard the "bottom pad" is the clip, so leads and jumper ends join it with no new
rule. `shape: { kind: 'strips' }` makes `holeExists` keep only strip holes. `board.rowLabels`
(display only) gives the printed names, through one `holeLabel` used by every message, edge and
sheet.

**Tech Stack:** TypeScript, zod, Vue 3 / Nuxt UI, three.js, Vitest (Node).

**Spec:** `docs/superpowers/specs/2026-11-19-wirebender-strips-design.md` (steps 1 and 2).

## Global Constraints

- `core/` has no Vue, Nuxt, Node or DOM imports.
- All new fields are optional. A board without `strips` reads, checks, draws and exports exactly as
  today: the existing tests and fixtures must pass unchanged.
- The file, the API and the MCP use grid names (`D12`). Printed names (`a12`) are display only.
- One rule for which holes exist: `holeExists(board.board, hole)` (now with the `strips` shape).
- Items on missing holes stay check findings, never parse errors (shapes rule). Breadboard rules
  that the format states (no trails, no joints…) are parse errors, since nothing can be drawn that
  way.
- `docs/format/wirebender-1.schema.json` is generated: `pnpm schema` after the zod change.
- Findings end with `Advisory only. Check the board with a meter before powering it.`
- Verification: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## Review Focus

1. A board without `strips` gives the same `buildConnectivity` groups, contacts and proposed
   joints as before. A snapshot test over every fixture board (Task 2).
2. A lead in a strip hole on a one-sided board joins the strip with nothing else drawn, and a
   bare trail crossing a strip hole without a joint is a contact (Task 2).
3. Two parallel strips of different nets give one `adjacent` finding, not one per hole (Task 3).
4. A DIP across the breadboard channel: no short. The same DIP one row up: a short whose message
   names the strip by its printed name (Tasks 3, 4).
5. `holeExists` with the `strips` shape doesn't rebuild the strip set per call: `existingHoles`
   on the 830 stays fast (the 2D view calls it on every render) (Task 1).
6. A breadboard can't get a trail, a joint, a leg fold or a solder bridge through any path: the
   format, the tools, the Move tool and the API (Tasks 1, 5).

---

### Task 1: Strips, the breadboard type and row labels in the format

**Files:** Create `core/strips.ts`, `tests/core/strips.test.ts`. Modify `core/schema.ts` (the
`board` type near line 46, zod near 116, new checks after `checkShape`, `checkOneSided` near 275),
`core/boardShape.ts` (`holeExists`), `docs/format/wirebender-1.md` (the `board` table, the rules
list), and regenerate `docs/format/wirebender-1.schema.json`.

**Interfaces (produces):**
- `BoardFile['board']`: `type: 'one-sided' | 'two-sided' | 'breadboard'`,
  `strips?: { from: HoleName, to: HoleName }[]`, `rowLabels?: string[]`,
  `shape?: BoardShape` where `BoardShape` gains `{ kind: 'strips' }`.
- `core/strips.ts`:
  - `stripHoles(s: Strip): Hole[]`: from `from` to `to` inclusive, in order.
  - `stripIndex(b: Board): Map<string, number>`: hole key → strip index. Cached in a `WeakMap`
    keyed on the `strips` array (boards are replaced, not mutated, on edit).
  - `isBreadboard(b: Board): boolean`.

**Format rules (parse errors, each with its path):**
- A strip runs along one row or one column: `board.strips[2]: B3 to D5 is not along one row or column`.
- Strip holes are in the grid: `board.strips[0].to: K40 is outside the 30 × 18 board`.
- Strips don't overlap: `board.strips[4]: shares E7 with board.strips[1]`.
- `shape: strips` needs strips: `board.shape: strips names no strip`.
- `rowLabels` has one entry per row: `board.rowLabels: 17 labels for 18 rows`. Labels may be `""`,
  and may repeat (both pairs of rails print `+` and `-`: a repeated label is shown with its grid
  name). None is a grid row name (`A`…), so `a12` can't be confused with a hole name: `a` is
  allowed, `A` is refused.
- A breadboard has no `trails`, `legFolds`, `solderBridges`, no wire `joints`, no `bareSegments`,
  and wires only on `top`: `trails[0]: a breadboard has no solder (trails)`, and so on.
- A breadboard has strips: `board.strips: a breadboard has no strips`.

- [ ] **Step 1: Failing tests** (`tests/core/strips.test.ts`, `tests/core/schema.test.ts`):
  - `stripHoles` of a row and of a column, either direction.
  - `holeExists` with `shape: strips`: strip holes yes, others no.
  - `existingHoles` on the 830 preset: 10 × 63 + the rail holes, under 5 ms (Focus 5).
  - Every error message above.
  - A board without the new fields parses as before.
  - A one-sided board with strips and no shape parses (a stripboard).
- [ ] **Step 2: Run** `pnpm vitest run tests/core/strips.test.ts tests/core/schema.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Document in the `board` table: `strips`, `rowLabels`, the
  `breadboard` type, and `shape: { "kind": "strips" }`. Add the rules to "Rules the schema can't
  express". Run `pnpm schema`.
- [ ] **Step 4: Run** `pnpm test` → PASS (formatDocs included).
- [ ] **Step 5: Commit** `feat(core): copper strips, the breadboard type and row labels in the format`

### Task 2: Strips in connectivity

**Files:** `core/connectivity.ts`; every `Conductor` consumer that switches on `kind`
(`grep -rn "kind === 'pad'\|case 'pad'" core app`, starting with `app/utils/boardView.ts`); tests in
`tests/core/connectivity.test.ts`.

**Interfaces:** `Conductor` gains `{ kind: 'strip', index: number }`.

- A strip is one node. It joins the bottom pad (`padNode(h, 'bottom')`) of each of its holes,
  creating the pad as `solder` would but marked as copper (`by: 'strip'`), so every strip hole has
  a pad.
- For the contact rule it's bare copper on the bottom, with every hole joined (`joined` holds all
  of its holes). A trail or a bare wire stretch on the bottom crossing a strip hole without a joint
  touches the pad there, as it touches solder today. That falls out of every strip hole having a pad.
- `groupAtHole(h, 'bottom')` on a strip hole gives the strip's group through the pad tier.
- On the top side nothing changes (one-sided stripboard: no top pads; breadboard: no top).

- [ ] **Step 1: Failing tests:**
  - **Snapshot (Focus 1):** for every board under `data/` and `docs/format/examples/`, groups,
    contacts and proposed joints are equal to the output without strips (they have none). Write
    the snapshot before changing the code.
  - **One-sided board with a strip A1–A10:**
    - R1 at A2–A6 with a second resistor at A8: one group.
    - A trail on the bottom along B1–B10 crossing nothing: its own group.
    - A trail across A5 without a joint: a contact with the strip (Focus 2).
  - **Breadboard:** a lead and a jumper end in one clip strip join, and two clip strips stay apart.
  - **groupAtHole:** gives a strip hole with nothing in it the strip's group.
- [ ] **Step 2: Run** `pnpm vitest run tests/core/connectivity.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Update the `Conductor` consumers (labels: "strip F1–J1", using
  `holeLabel` from Task 4 once it exists; plain grid names until then).
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(core): strips join their holes in connectivity`

### Task 3: Checks with strips

**Files:** `core/check/spacing.ts` (adjacency), `core/check/nets.ts` (short message),
`core/check/context.ts` (`sides` for a breadboard); tests in `tests/core/check.test.ts`.

- **Adjacency:** two neighbouring holes that are both on strips (different strips) are reported
  once per pair of groups, not once per hole pair. The finding holds every neighbouring hole pair,
  and the message names the two strips and the closest pair:
  `Adjacent: VCC strip A1–A30 runs next to GND strip B1–B30 (A1 next to B1, and 29 more) (shorts the supply)`.
  Other holes keep the per-pair finding (Focus 3).
- **Short through a strip:** the message says which strip joins the nets
  (`… joined through strip F12–J12`). On a breadboard it adds: `Move one of the parts to another
  strip.` A DIP whose rows sit on one clip strip gives this (Focus 4).
- **Breadboard sides:** `ctx.sides` is `['bottom']` (the clip tier). The 2D and 3D views show the
  top only (Tasks 6, 7), and nothing in the check speaks of sides on a breadboard: messages say
  "on the board", not "on the bottom".
- **Rules that need solder** (`missingJoint`, contact proposals) never fire on a breadboard. They
  can't, as nothing bare exists there: a test confirms it.

- [ ] **Step 1: Failing tests:**
  - Parallel strips VCC and GND → one `adjacent` finding with 30 pairs.
  - **Breadboard 400 with a dip8 across the channel:** no short.
  - **The same dip8 at rows `b`–`e`:** each pin pair `1/8`, `2/7`… shares a clip strip, so the
    test gets shorts naming the strip, and the move hint.
  - A breadboard board runs every rule with no solder wording.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(check): strips in the adjacency and short findings`

### Task 4: Printed names

**Files:** Create `core/holeLabel.ts`; modify `core/edgeLabels.ts`, `core/check/*.ts` (message
strings: `holeName` → `holeLabel`, about 30 sites), `core/bench/sheet.ts`, `core/bench/cards.ts`;
callers of `edgeLabels` (`core/scene3d/board.ts`, the 2D `Holes.vue` / `BoardSide.vue`); tests.

**Interfaces:**
- `holeLabel(b: Board, h: Hole): string`: `a12 (D12)` when `rowLabels` gives that row a
  different name, else `D12`. The `holes` arrays in findings stay grid names (they light holes).
- `printedName(b: Board, h: Hole): string`: `a12` alone, for the drawing and the bench sheet's
  placement table, where the grid name would only clutter.
- `edgeLabels(b: Board)`: the signature changes from `(cols, rows)`. Rows take `rowLabels` when
  given, and rows with an empty label get none. On a breadboard, columns are numbered 1, 5, 10, …
  like the print. Other boards are unchanged.

- [ ] **Step 1: Failing tests:**
  - `holeLabel` and `printedName` on the 400 (a rail, a clip row, an empty row).
  - `edgeLabels` on the 400 and on a plain board (same as today).
  - A finding message on the 400 reads `a12 (D12)`.
  - Every existing check test is unchanged (no `rowLabels`).
- [ ] **Step 2–4:** Run → FAIL; implement; `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(core): printed row names in findings, edges and the bench sheet`

### Task 5: Editing a breadboard (jumpers)

**Files:** `core/edit.ts` (new `jumperClick`, refusals), `core/move.ts` (no folds on a
breadboard), `app/composables/useTools.ts`, `app/components/Toolbar.vue`; tests in
`tests/core/edit.test.ts`, `tests/core/move.test.ts`, `tests/app/useTools.test.ts`.

The app draws trails only today; wires come from the API and the MCP. A breadboard needs jumpers:

- **`jumperClick(board, hole, drawing)`**, like `pencilClick`: the first click starts a laid wire
  on the top (`kind: 'laid'`, `bareSegments: []`, `joints: []`, a new `W…` id), and each further
  click adds a corner along a row or a column. Clicking the last point again, or `Esc`, ends it.
  A jumper ends on a hole that exists. A one-point jumper is removed when it ends.
- **On a breadboard:**
  - **The pencil (P)** draws jumpers.
  - **The Joint tool (J)** is hidden from the toolbar, and its key does nothing.
  - **Erase** on a jumper's segment removes the whole jumper (real jumpers aren't cut in two):
    `eraseSegment` gains a wire case, used only on a breadboard.
  - **`pencilClick` and `toggleJoint`** refuse with `A breadboard has no solder: the pencil draws
    jumpers.` (for the API path through `core/edit.ts`).
  - **The Move tool** never makes leg folds. Bending a part's legs (Tab) is off, with the hint
    `Legs plug straight in on a breadboard.`
- [ ] **Step 1: Failing tests:**
  - `jumperClick`: start, a corner, end, a diagonal click refused, a missing hole refused.
  - Erase removes the whole jumper.
  - The refusals above.
  - The Move tool on a breadboard gives no folds.
  - The useTools key J is ignored on a breadboard.
- [ ] **Step 2–4:** Run → FAIL; implement; `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(edit): jumpers on a breadboard; no solder tools there`

### Task 6: 2D: the breadboard look and strips

**Files:** `app/pages/b/[id].vue` (`frames`, `FRAMINGS`, the `KEYS` hint), `app/components/board/Holes.vue`,
`app/components/board/Copper.vue`, `app/components/BoardSide.vue`; tests in `tests/app/`
for any new util (for example `app/utils/breadboardLook.ts`: channel rectangle, rail lines).

- **Breadboard:**
  - The top frame only: no bottom frame, no "Bottom" framing button, and `F` frames the top.
  - An ivory board with square holes. The channel is drawn as a darker groove between `e` and `f`.
  - Red (`+`) and blue (`-`) lines along the rails, with `+` and `-` printed at both ends, and
    row letters and column numbers from `edgeLabels`.
  - Hovering a hole lights its whole clip strip. This is the existing group highlight, which now
    reaches the strip.
- **One-sided board with strips (a custom stripboard through the API):** copper bands under the
  holes on the bottom frame, the colour of pads. There's no cut drawing yet (release 2).
- [ ] **Step 1: Failing tests** for the util (channel and rail line geometry on the 400 and
  830; none on the 170 for rails).
- [ ] **Step 2–4:** Run → FAIL; implement; `pnpm test` → PASS. Check it in the app (`/run`):
  the 400 and 830 presets, hover a clip strip, draw a jumper, place a dip8 across the channel.
- [ ] **Step 5: Commit** `feat(app): the breadboard drawn like one; strips on the bottom side`

### Task 7: 3D

**Files:** `core/scene3d/board.ts`, `core/scene3d/conductors.ts`, `core/scene3d/parts.ts`,
`core/scene3d/types.ts`, `app/utils/scene3dThree.ts`, `app/components/Board3D.vue` (no bottom
camera preset on a breadboard); tests in `tests/core/scene3d*.test.ts`.

- **Breadboard:**
  - **Block:** an ivory block 8.5 mm thick (`BREADBOARD_THICKNESS_MM`), its top at y = 0 as
    today, with square holes (`holeShape: 'square'` on the slab).
  - **Print:** the channel as a 1 mm deep groove, the rail lines and the printed labels on the top.
  - **Parts and jumpers:** no pads and no solder cones. Legs go into the holes 3 mm and stop.
    Jumpers lie on the top (laid) as today.
- **Strips on a one-sided board:** copper bands on the bottom (`kind: 'box'` prims, pad colour)
  under the pads.
- [ ] **Step 1: Failing tests:**
  - The 400: slab thickness, no pad prims, no solder prims, the groove prim, and the rail line
    prims with their colours.
  - A one-sided board with strips: one band per strip.
  - A plain board's scene is unchanged (the existing scene tests).
- [ ] **Step 2–4:** Run → FAIL; implement; `pnpm test` → PASS; check it in the app.
- [ ] **Step 5: Commit** `feat(3d): the breadboard block and copper strips`

### Task 8: The bench sheet on a breadboard

**Files:** `core/bench/sheet.ts`, the sheet's app/print component (find it with
`grep -rn benchModel app server`); tests in `tests/core/bench*.test.ts`.

- **Placement table:** each part's holes in printed names (`a12`–`a15`). There's no solder
  step, and the leg-fold, trail and solder-bridge sections are left out.
- **Jumpers:** each jumper's ends in printed names and its cut length (the wire cards as today).
  The title is "Jumpers", not "Wires".
- **Meter checks:** stay. Beeping between two clip holes on a breadboard is still a useful check.
- [ ] **Step 1: Failing tests** on the 400 with a dip8, two resistors and three jumpers.
- [ ] **Step 2–4:** Run → FAIL; implement; `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(bench): the breadboard sheet: placements and jumpers`

### Task 9: The three breadboard presets

**Files:** `core/boardPresets.ts` (`BoardPreset` gains `strips`, `rowLabels`, and
`type: 'breadboard'`; a `breadboard(...)` builder), `app/utils/newBoard.ts`, `cli/mcp.ts` (the
preset list is already shared; check the descriptions), `README.md`; tests in
`tests/core/boardPresets.test.ts`, `tests/server/api.test.ts`, `tests/cli/mcp.test.ts`.

The layouts come from sellers' drawings; they're to be confirmed on a real board before release:

| id | Name | Cols | Grid rows | Rails |
| --- | --- | --- | --- | --- |
| `bb-830` | Breadboard 830 (split rails) | 63 | 18 | 4, each in two halves of 25 |
| `bb-830-full` | Breadboard 830 | 63 | 18 | 4, each 50 holes |
| `bb-400` | Breadboard 400 | 30 | 18 | 4, each 25 holes |
| `bb-170` | Breadboard 170 | 17 | 12 | none |

- **Rows (830, 400):**
  - 1 and 2: rails (`+`, `-`).
  - 3: empty.
  - 4–8: `j`–`f`.
  - 9 and 10: the channel.
  - 11–15: `e`–`a`.
  - 16: empty.
  - 17 and 18: rails (`-`, `+`).

  Row `a` is at the bottom, like most prints. Which rail is `+` on top is to confirm.
- **Rows (170):** 1–5 `j`–`f`, 6 and 7 the channel, 8–12 `e`–`a`.
- **Clip strips:** one per column on each half (rows 4–8 and 11–15; on the 170, 1–5 and 8–12).
- **Rails:** groups of 5 with one empty hole between them, centred on the columns. On the 400
  that's 29 places from column 2 to 30; on the 830, 59 places from column 3 to 61. A split rail is
  two strips, broken at the middle gap.
- **Shape:** `{ kind: 'strips' }`; `type: 'breadboard'`.

- [ ] **Step 1: Failing tests:**
  - **Per preset:** it parses, has the hole count of its name (830 tie points, 400, 170 — rails
    included, so the counts check the layout), and every clip strip has 5 holes.
  - **Rows:** `rowLabels` matches the rows.
  - **API and MCP:** `POST /api/boards { name, preset: 'bb-400' }` and the MCP `create_board`
    with that preset both make it.
- [ ] **Step 2–4:** Run → FAIL; implement; `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(presets): breadboards 830, 400 and 170`

### Task 10: Docs and wrap-up

- **README:** breadboard boards, jumpers with the pencil, and the presets list.
- **Spec:** bring it in line with anything the tasks changed (the jumper pencil, the 170's 12
  rows, `rowLabels` in the file and the row order are already in it).
- **Backlog:** release 1 done once merged. Before release: confirm the four layouts on a real
  board (the hole counts in Task 9 check the arithmetic, not the board).
- `pnpm test`, `pnpm typecheck`, `pnpm lint` → PASS.
- **Commit:** `docs: strips and breadboard`
