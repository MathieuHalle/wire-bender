# WireBender milestone 1 (board model, check, editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Channel board 2 opens in a local browser editor that shows both sides at real
size, lets the owner redraw bare trails with pencil / erase / joint tools, re-runs the
technical check after every edit, and stays in sync with the board file Claude edits.

**Architecture:** A pure TypeScript core (`core/`: board model, footprints, connectivity,
check, edit operations) with no Vue or Node dependencies, used by a Nuxt 4 app (editor
UI + Nitro server routes that read, write and watch the board file) and by a `tsx` CLI.
The board file is JSON on disk, addressed by path; the server watches it and pushes a
revision event to the page over SSE.

**Tech Stack:** Node 22, pnpm 9, Nuxt 4.6, @nuxt/ui 4.12, TypeScript, Vitest 5,
zod (file validation), chokidar 6 (file watch), tsx (CLI).

**Spec:** `docs/superpowers/specs/2026-11-05-wirebender-design.md`. This plan covers build
order step 1 (spec §11). Bench export (§6) and 3D (§5, last bullet) get their own plans.

## Global Constraints

- Project root: `/Users/stakabo/Work/repos/BH/perfwire`. Name in UI, package and README: **WireBender**.
- `reference/` is a read-only reference (perfwire upstream, Apache-2.0). Never import from it at runtime.
- Anything ported from perfwire keeps credit: `NOTICE` names perfwire (https://github.com/KeckuJp/perfwire, Apache-2.0) and every ported file has a header comment `Logic ported from perfwire solver.py <function>, Apache-2.0`.
- Licence: Apache-2.0 (`LICENSE` copied from `reference/perfwire-upstream/LICENSE`).
- `core/` imports nothing from Vue, Nuxt, Node `fs`, or the DOM. One engine only: the UI and CLI call the same `core/` functions.
- Never silently replace wiring the owner drew; never silently show an older version (spec §2 anti-goals).
- Never claim a board is safe to power. The findings panel and CLI output end with: `Advisory only. Check the board with a meter before powering it.`
- English UI. Hole names are row letter + column number, row A at the top: `G13` = row 7, column 13. Rows past Z continue `AA, AB, ...`.
- Hole pitch 2.54 mm. All drawing in SVG uses millimetres as user units.
- Icon: original pixel art (robot head on a perfboard grid, bent-wire antenna). No Futurama / Bender artwork, ever.
- Commit after each task with the attribution lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01J81HjMZYUjAKfCSSaUaXzJ`.

## Review Focus

1. **A hand-edited board file with a bad hole name, an unknown footprint or a missing `revision`**: the page shows a readable error naming the path (`parts[3].at: "Z99" is outside the 18 x 24 board`) and keeps the last good board; the CLI exits 2 with the same message. → Task 2 test `rejects out-of-grid hole with a path`, Task 8 test `GET returns 422 with errors`.
2. **Claude writes the file while the page is mid-save, or writes half a file**: the server writes atomically (temp file + rename), a read of invalid JSON is reported, not crashed on, and the page never overwrites a newer revision. → Task 8 tests `PUT with stale baseRevision returns 409` and `write is atomic`.
3. **Pencil clicks that can't be drawn** (diagonal from the last point, a blocked hole, a top-side hole under a part body, a top-side trail on a one-sided board): nothing is drawn and a reason is shown. → Task 6 test `pencil rejects diagonal / blocked / under-body / top-on-one-sided`.
4. **Erasing the middle segment of a trail**: two trails result, each keeping only its own joints; erasing the last segment of a 2-point trail removes the trail. → Task 6 test `erase splits and keeps joints`.
5. **A trail passing over another net's leg on the same side** reports a short, even with no joint drawn there; passing over an empty hole does not. → Task 4 test `trail over other-net leg is a short`.

---

## File Structure

```
package.json, nuxt.config.ts, tsconfig.json, vitest.config.ts, app.config.ts
LICENSE, NOTICE, README.md, CLAUDE.md, .gitignore (exists)
core/
  holes.ts         hole names <-> {col,row}, mm positions, straight-run expansion
  schema.ts        BoardFile types + zod schema + parseBoard()
  footprints.ts    built-in footprint library + placePart() (rotation/flip -> holes, body cells)
  connectivity.ts  conductor graph (union-find), contact rule, proposed joints
  check.ts         runCheck(): findings list
  edit.ts          pure edit operations: pencil, erase, toggleJoint
  index.ts         re-exports
cli/
  wirebender.ts    `wirebender check <file>`
server/
  utils/boardFile.ts   resolve path, read/validate, atomic write, watch
  api/board.get.ts     GET  /api/board
  api/board.put.ts     PUT  /api/board
  api/board/events.get.ts  SSE /api/board/events
app/
  app.vue
  pages/index.vue
  components/BoardSide.vue      one side as SVG
  components/Toolbar.vue
  components/FindingsPanel.vue
  composables/useBoard.ts       load, autosave, SSE, conflict, undo
  composables/useTools.ts       tool state machine over core/edit
public/icon.svg
data/channel-board-2.wirebender.json    demo / dev / test data
tools/import_channel_board.py           throwaway importer (Python, reads light-ctrl)
tests/core/*.test.ts, tests/server/*.test.ts
```

---

### Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `nuxt.config.ts`, `tsconfig.json`, `vitest.config.ts`, `app/app.vue`, `app/pages/index.vue` (placeholder), `LICENSE`, `NOTICE`, `README.md`, `CLAUDE.md`, `public/icon.svg`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: scripts `pnpm dev` (Nuxt dev server), `pnpm test` (`vitest run`), `pnpm check <file>` (`tsx cli/wirebender.ts check`), `pnpm typecheck` (`nuxt typecheck`). Path alias `~core` → `./core` usable from app, server, cli and tests.

- [ ] **Step 1:** `pnpm dlx nuxi@latest init . --template ui --packageManager pnpm --gitInit false` (Nuxt 4 + Nuxt UI template). If the folder-not-empty prompt appears, choose merge; keep the existing `.gitignore` and `docs/`.
- [ ] **Step 2:** `pnpm add zod chokidar` and `pnpm add -D vitest tsx`. Add the four scripts above. Add the `~core` alias in `nuxt.config.ts` (`alias`) and `vitest.config.ts` (`resolve.alias`).
- [ ] **Step 3:** Write `tests/smoke.test.ts`: `expect(1 + 1).toBe(2)`. Run `pnpm test` → 1 passed.
- [ ] **Step 4:** `LICENSE` = copy of `reference/perfwire-upstream/LICENSE`. `NOTICE`: "WireBender. Copyright 2026 the WireBender authors. Includes ideas and rule logic ported from perfwire (https://github.com/KeckuJp/perfwire), Apache-2.0." `README.md`: one paragraph (what it is, `pnpm install`, `WIREBENDER_BOARD=path pnpm dev`, `pnpm check path`). `CLAUDE.md`: points to the spec and this plan, states the Global Constraints "core has no UI/Node deps" and "advisory only" rules, lists `pnpm test` and `pnpm typecheck` as the verification commands.
- [ ] **Step 5:** `public/icon.svg`: original 12 x 16 pixel-art robot head on a light perfboard grid (grey pixels with a darker visor band, two square eyes, a grille mouth), antenna drawn as a bent copper-coloured wire with two 90° bends ending in a round solder blob. Set it as the favicon in `nuxt.config.ts` `app.head.link`.
- [ ] **Step 6:** `app/pages/index.vue` shows the icon and "WireBender". Run `pnpm dev`, open http://localhost:3000, confirm the page and favicon render. Stop the server.
- [ ] **Step 7:** Commit `chore: scaffold WireBender (Nuxt 4, Nuxt UI, vitest)`.

### Task 2: Hole names and the board file schema

**Files:**
- Create: `core/holes.ts`, `core/schema.ts`, `core/index.ts`
- Test: `tests/core/holes.test.ts`, `tests/core/schema.test.ts`

**Interfaces:**
- Produces:
  - `type Hole = { col: number; row: number }` (1-based)
  - `parseHole(name: string): Hole` (throws `Error("bad hole name: X")`), `holeName(h: Hole): string`
  - `holeMm(h: Hole, pitchMm = 2.54): { x: number; y: number }` → `{ x: (col-1)*pitch, y: (row-1)*pitch }`
  - `straightRun(a: Hole, b: Hole): Hole[]` → every hole from a to b inclusive; throws `Error("diagonal")` if neither col nor row is shared
  - `holeKey(h: Hole): string` → `"c,r"`
  - Types exported from `core/schema.ts` (these are the file format, `format: "wirebender/1"`):

```ts
type HoleName = string
type Side = 'top' | 'bottom'
type PinRole = 'in' | 'out' | 'pwr' | 'oc' | 'passive'
interface BoardFile {
  format: 'wirebender/1'
  revision: number                       // server increments on every save
  name: string
  board: { cols: number; rows: number; pitchMm: number;
           type: 'one-sided' | 'two-sided'; blocked: { holes: HoleName[]; reason: string }[] }
  netClasses: Record<string, { color?: string }>
  nets: Record<string, { class?: string; color?: string }>
  rules: {
    keepAway: { a: string; b: string; holes: number }[]          // class names; 1 = 8-neighbours
    adjacency: { classes: [string, string]; level: 'supply' | 'mcu' }[]  // anything else = 'harmless'
  }
  parts: Part[]
  trails: Trail[]
  wires: Wire[]
  legFolds: { lead: string; to: HoleName }[]                     // lead = "REF.pin"
  solderBridges: { side: Side; a: HoleName; b: HoleName }[]
  bench: { endLeadMm: number; bendAllowanceMm: number; spareMm: number;
           flyingSlackMm: number; roundToMm: number }
}
interface Part { ref: string; footprint: string; at: HoleName; to?: HoleName;   // `to` = second lead of a 2-lead part
                 rotation: 0 | 90 | 180 | 270; flip?: boolean; standing?: boolean;
                 value?: string; label?: string; pins: Record<string, string | null> }  // pin -> net; null = NC
interface Trail { id: string; side: Side; points: HoleName[]; joints: HoleName[] }
interface Wire  { id: string; kind: 'laid' | 'flying'; side: Side; points: HoleName[];   // >= 2, first = start
                  color?: string; bareSegments: number[]; joints: HoleName[] }            // indexes into points pairs
```
  - `parseBoard(json: unknown): { ok: true; board: BoardFile } | { ok: false; errors: string[] }`. Errors use a path prefix (`parts[3].at: ...`). Checks: zod shape; every HoleName parses and is inside `cols x rows`; consecutive trail/wire points share a row or column (wire `kind: 'flying'` exempt); every part footprint exists (Task 3 adds the registry lookup; here accept any non-empty string); nets referenced by pins exist in `nets` or are created implicitly (allowed: add missing nets with no class and report nothing); `bench` defaults `{5, 1, 5, 10, 5}` when absent; `revision` defaults to 0 when absent.

- [ ] **Step 1: Write the failing tests.**
  - `holes.test.ts`: `parseHole('G13')` → `{col:13,row:7}`; `parseHole('AA2')` → `{col:2,row:27}`; `holeName({col:13,row:7})` → `'G13'`; round-trip for all holes of 18 x 30; `parseHole('13G')` throws; `straightRun(G2,G5)` has 4 holes in order; `straightRun(G5,G2)` reversed order; `straightRun(A1,B2)` throws `diagonal`; `holeMm({col:2,row:1})` → `{x:2.54,y:0}`.
  - `schema.test.ts`: a minimal valid board parses; `rejects out-of-grid hole with a path` (part `at: 'Z99'` on 18 x 24 → error string contains `parts[0].at` and `outside the 18 x 24 board`); a diagonal trail step → error containing `trails[0].points[1]`; missing `revision` → `revision === 0`; missing `bench` → defaults above.
- [ ] **Step 2:** `pnpm test tests/core` → FAIL (modules missing).
- [ ] **Step 3:** Implement `core/holes.ts` and `core/schema.ts`.
- [ ] **Step 4:** `pnpm test tests/core` → PASS.
- [ ] **Step 5:** Commit `feat(core): hole names and board file schema`.

### Task 3: Footprint library and part placement

**Files:**
- Create: `core/footprints.ts`
- Modify: `core/schema.ts` (footprint id must exist in the registry → error `parts[i].footprint: unknown "X"`)
- Test: `tests/core/footprints.test.ts`

**Interfaces:**
- Consumes: `Hole`, `parseHole`, `Part` (Task 2).
- Produces:

```ts
interface Footprint {
  id: string; name: string
  pins: { name: string; dx: number; dy: number; role?: PinRole }[]   // offsets in holes from pin 1, rotation 0
  twoLead?: { minSpan: number; maxSpan: number }   // holes between `at` and `to`; pins are 'a' (at) and 'b' (to)
  body: { // rotation 0, mm, relative to pin 1 centre; x right, y down
          rect: { x: number; y: number; w: number; h: number }; heightMm: number; round?: boolean
          side: 'top' }
  mark?: 'pin1' | 'stripe-b' | 'flat' | 'tab'      // what to draw for orientation
}
const FOOTPRINTS: Record<string, Footprint>
interface PlacedPart { part: Part; fp: Footprint; pins: { name: string; hole: Hole; net: string | null; role: PinRole }[];
                       bodyHoles: Hole[];              // holes under the body (excluding its own pins)
                       bodyRectMm: { x: number; y: number; w: number; h: number } }  // board mm, after rotation/flip
placePart(part: Part): PlacedPart
```
  - Rotation is clockwise seen from the top, about pin 1: `(dx,dy) → (-dy,dx)` per 90°. `flip` mirrors `dx → -dx` before rotation. For `twoLead` parts, `to` sets lead b and rotation is ignored; `standing: true` puts the body over lead a only (circle of the body diameter).
  - `bodyHoles` = holes whose centre lies strictly inside `bodyRectMm` shrunk by 0.3 mm, minus the part's own pin holes.
  - Library (values for v1; pin offsets reproduce channel board 2 exactly):

| id | pins (name dx,dy) at rotation 0 | body rect mm (w x h, from pin 1) | height |
|---|---|---|---|
| `relay-g5v2` | 1 (0,0) 16 (3,0) 4 (0,3) 13 (3,3) 6 (0,5) 11 (3,5) 8 (0,7) 9 (3,7) | 10.1 x 20.5, centred on the pin box | 11.5 |
| `to220-gds` | G (0,0) D (0,1) S (0,2) | 4.5 x 10.0 (body beside the pin column, tab side noted by `mark: 'tab'`) | 15.5 |
| `dip8` | 1..4 (0,0..3), 5..8 (3,3..0) | 6.35 x 9.8, centred on the pin box | 4.5 |
| `terminal-2p-508` | 1 (0,0) 2 (2,0) | 10.16 x 7.6, covering the pin row and the row below it (dy 0..1) | 10 |
| `header-1x5` | 1..5 (0..4,0) | 12.7 x 2.5 | 8.5 |
| `polyfuse-radial` | twoLead 2..2 | 8.9 x 3.0 between the leads | 13 |
| `axial` | twoLead 3..6 (lying) | 6.3 x 2.5 between the leads; standing: circle 2.7 dia over lead a | 2.5 / 7 |
| `cap-disc` | twoLead 1..2 | 5.0 x 2.5 | 8 |

  These body sizes are starting values from typical datasheets; the implementer keeps them as data in this table, nothing else depends on the exact numbers.

- [ ] **Step 1: Write the failing tests.**
  - `relay at D3 rotation 0` → pin 16 at `D6`, pin 9 at `K6`.
  - `dip8 rotation 90 at W8`-style: placing `dip8` with `at` and rotation chosen so pins land on channel board 2's U1 holes. Compute the expected holes in the test from channel_board.py: `U1_HOLES = rotate({"1":"W11","2":"V11","3":"U11","4":"T11","5":"T8","6":"U8","7":"V8","8":"W8"}, 1)` (copy the resulting 8 hole names into the test literal by running that one Python expression once in `light-ctrl/re/boards`).
  - `terminal body covers the row below`: `terminal-2p-508` at `A3` → `bodyHoles` contains `B3`, `B4`, `B5`, `A4`, not `A3`, `A5`.
  - `standing axial body only around lead a`: `axial` `at: L2, to: L1, standing: true` → `bodyHoles` empty.
  - `rotation 180 then 0 is identity` for every footprint.
  - schema: unknown footprint → error `parts[0].footprint: unknown "nope"`.
- [ ] **Step 2:** `pnpm test tests/core/footprints.test.ts` → FAIL.
- [ ] **Step 3:** Implement `core/footprints.ts`; wire the registry check into `parseBoard`.
- [ ] **Step 4:** `pnpm test tests/core` → PASS.
- [ ] **Step 5:** Commit `feat(core): footprint library with rotation, flip and real body outlines`.

### Task 4: Connectivity (conductor graph and contact rule)

**Files:**
- Create: `core/connectivity.ts`
- Test: `tests/core/connectivity.test.ts`

**Interfaces:**
- Consumes: `BoardFile`, `placePart`, `straightRun`, `holeKey`.
- Produces:

```ts
type Conductor = { kind: 'lead'; id: string /* "U1.2" */ } | { kind: 'trail'; id: string }
               | { kind: 'wire'; id: string } | { kind: 'pad'; hole: Hole; side: Side }
interface Connectivity {
  groups: { conductors: Conductor[]; nets: string[]; leads: string[] }[]   // electrically joined sets
  groupOfLead: Map<string, number>
  contacts: { hole: Hole; side: Side; trailId: string; with: string; sameNet: boolean }[]  // trail passing a leg/solder
  proposedJoints: { trailId: string; hole: Hole }[]   // needed joints the trail doesn't list yet
  netAtHole(h: Hole, side: Side): string | null
}
buildConnectivity(board: BoardFile): Connectivity
```
  Algorithm (union-find over conductors; perfwire's `erc_audit` open-net union-find is the reference, but the node model here is side-aware):
  - Every lead is soldered to `pad(hole, 'bottom')` (implicit joint). On `two-sided` boards a lead also joins `pad(hole,'top')` only if a top-side trail or wire has a joint at that hole.
  - A wire end goes through its hole: it joins `pad(end,'bottom')`, and `pad(end,'top')` on two-sided boards when a top-side joint is listed there.
  - A trail or wire joins `pad(h, side)` at each of its `joints` and at its first and last points.
  - **Contact rule (spec §9b):** a trail on side S that passes over a hole holding a lead or a wire end, or having any solder on side S (a joint of another trail/wire, a solder bridge end), joins that hole's conductors even without a joint. Record it in `contacts`; if the net is the same and the trail lacks a joint there, add to `proposedJoints`.
  - Bare segments of a `laid` wire behave like a trail for the contact rule; insulated segments make no contact.
  - Leg-fold: the lead joins `pad(to,'bottom')`. Solder bridge: joins `pad(a,side)` and `pad(b,side)`.
  - Pads of the two sides of a hole are never joined by the board itself (`two-sided` is unplated).
  - Group `nets` = distinct nets of the leads in the group.

- [ ] **Step 1: Write the failing tests** (small hand-made boards, 10 x 10, built with a test helper `mk(partial)` that fills defaults):
  - `trail joins two leads`: R1 axial C2–C5, R2 axial F2–F5, nets A on C5 and F2… trail bottom `C5,F5? ` — use: R1.b at `C5` net N, R2.a at `F5` net N, trail `[C5, F5]` → R1.b and R2.a in one group.
  - `trail over other-net leg is a short`: trail `[C2, C8]` bottom, nets N at C2 and C8, a lead of net M at `C5` → one group with nets `[M, N]`.
  - `trail over empty hole makes no contact`: same without the lead at C5 → group nets `[N]`, `contacts` empty.
  - `proposed joint for same-net leg passed over`: lead of net N at C5 → `proposedJoints` = `[{trailId, hole: C5}]`.
  - `sides don't connect through an empty hole`: two-sided board, top trail `[B2,B6]`, bottom trail `[B6,B9]`, no lead or wire end at B6 → two groups.
  - `wire end joins both sides with a top joint`: same but a wire end at B6 and top trail joint at B6 → one group.
  - `leg fold joins the target pad`: lead D1.b at `L1`, legFold to `L2`, trail starting at `L2` → same group.
  - `insulated wire segment makes no contact`: laid wire `[C2, C8]`, `bareSegments: []`, other-net lead at C5 → no merge.
- [ ] **Step 2:** `pnpm test tests/core/connectivity.test.ts` → FAIL.
- [ ] **Step 3:** Implement `core/connectivity.ts`. Header comment: `Logic ported from perfwire solver.py erc_audit (open-net union-find), Apache-2.0`.
- [ ] **Step 4:** `pnpm test tests/core` → PASS.
- [ ] **Step 5:** Commit `feat(core): side-aware connectivity with the trail contact rule`.

### Task 5: The technical check

**Files:**
- Create: `core/check.ts`
- Test: `tests/core/check.test.ts`

**Interfaces:**
- Consumes: `buildConnectivity`, `placePart`, `BoardFile`.
- Produces:

```ts
type Severity = 'error' | 'warning' | 'caution'
interface Finding { rule: RuleId; severity: Severity; level?: 'supply' | 'mcu' | 'harmless';
                    holes: HoleName[]; message: string }
type RuleId = 'openNet' | 'short' | 'singleLeadNet' | 'contention' | 'twoInOneHole'
            | 'bodyCollision' | 'underBody' | 'blockedHole' | 'keepAway' | 'adjacent' | 'missingJoint'
runCheck(board: BoardFile): { findings: Finding[]; stats: { nets: number; groups: number; errors: number; warnings: number; cautions: number } }
```
  Rules (messages are plain English and name holes and refs, e.g. `Short: nets V12 and IN_A are joined (trail T7 passes over U1.2 at W9)`):
  - `openNet` (error): a net whose leads sit in more than one group. Message lists the groups' leads.
  - `short` (error): a group with 2+ nets. If a contact caused it, name the trail and hole.
  - `singleLeadNet` (warning): a net with exactly one lead. NC pins (`null`) never count and never warn.
  - `contention` (error): 2+ pins with role `out` in one group.
  - `twoInOneHole` (error): two leads, or a lead and a wire end, in one hole.
  - `bodyCollision` (error): two parts' `bodyRectMm` overlap by more than 0.2 mm in both axes.
  - `underBody` (error): a lead of another part, a wire end, or a top-side trail/wire point or joint in a part's `bodyHoles`.
  - `blockedHole` (error): any lead, wire end, trail point or joint in a blocked hole.
  - `keepAway` (warning): for each `rules.keepAway {a, b, holes}`, any hole carrying a class-a net within `holes` (Chebyshev distance) of a hole carrying a class-b net, on the same side — counting leads, trail holes, joints and wire ends (spec: trails, not just pins).
  - `adjacent` (caution): two 4-neighbour holes on the same side carrying different nets. `level` from `rules.adjacency` by the two nets' classes, else `harmless`; neighbouring pins of the same part are always `harmless`. Report one finding per hole pair.
  - `missingJoint` (warning): each `proposedJoints` entry.
  - The last line of any rendered findings list is the advisory sentence from Global Constraints (Task 7 and Task 10 render it; `runCheck` only returns data).

- [ ] **Step 1: Write the failing tests** — one per rule, on `mk()` boards, plus the planted-error cases from spec §9b:
  - `trail one hole short → openNet` (trail ends at C4, lead at C5).
  - `trail into the wrong pin → short`.
  - `swapped inputs → short on both` (two nets crossed onto each other's pins → 2 `short` findings or `openNet`s; assert both nets appear).
  - `two legs in one hole → twoInOneHole`.
  - `12 V next to a logic line → adjacent level 'mcu'` with classes HV12/LOGIC and `rules.adjacency [{classes:['HV12','LOGIC'],level:'mcu'}]`; `HV12 next to GND → 'supply'`; two LOGIC nets → `'harmless'`; neighbouring pins of the same header with nets HV12/LOGIC → `'harmless'`.
  - `keepAway counts trail holes`: LOGIC lead at E5, HV12 trail passing E6, `keepAway [{a:'LOGIC',b:'HV12',holes:1}]` → 1 finding.
  - `NC pin never warns`: dip8 with pins 1 and 8 `null` → no `singleLeadNet`, no `openNet`.
  - `wire end in a terminal's covered row → underBody`.
  - `contention`: two `out` pins in one group.
- [ ] **Step 2:** `pnpm test tests/core/check.test.ts` → FAIL.
- [ ] **Step 3:** Implement `core/check.ts`. Header comment: `Rule logic ported from perfwire solver.py erc_audit/topology_audit, Apache-2.0`.
- [ ] **Step 4:** `pnpm test tests/core` → PASS.
- [ ] **Step 5:** Commit `feat(core): technical check with severity buckets`.

### Task 6: Edit operations (pencil, erase, joint)

**Files:**
- Create: `core/edit.ts`
- Test: `tests/core/edit.test.ts`

**Interfaces:**
- Consumes: `BoardFile`, `buildConnectivity`, `placePart`, `straightRun`.
- Produces (all pure; return a new board, never mutate):

```ts
interface Drawing { trailId: string; side: Side }          // trail being drawn
type EditResult = { ok: true; board: BoardFile; drawing: Drawing | null } | { ok: false; reason: string }
pencilClick(board: BoardFile, side: Side, hole: Hole, drawing: Drawing | null): EditResult
eraseSegment(board: BoardFile, side: Side, a: Hole, b: Hole): EditResult    // a,b adjacent holes on one segment
toggleJoint(board: BoardFile, side: Side, hole: Hole): EditResult
nextTrailId(board: BoardFile): string                       // "T1", "T2", ... first unused
```
  - `pencilClick` with `drawing === null`: start a new trail `{points:[hole], joints:[]}` → `drawing` set. With a drawing: if `hole` equals the last point, end (`drawing: null`; a 1-point trail is removed). If `hole` is not on the last point's row/col → `reason: "Trails run along a row or a column: click a hole in the same row or column."` Otherwise append. If the new hole already has a trace on this side (another trail or a wire end), end the trail there and add a joint at that hole.
  - Rejections (`ok:false`, nothing changed): blocked hole (`"Hole X is blocked: <reason>"`), top side on a one-sided board (`"This board has no pads on the top side."`), top-side hole in a part body (`"Hole X is under RELAY KA"`).
  - When a trail point lands on a hole with a lead, add a joint there automatically.
  - `eraseSegment`: removes the stretch between a and b. If it is in the middle, the trail splits in two at a and b (new id via `nextTrailId`), each keeping the joints that lie on its own holes. A remaining 1-point trail is removed. Wires are never touched.
  - `toggleJoint`: only on a hole a trail on that side passes over; else `reason: "No trail on this side at X."`

- [ ] **Step 1: Write the failing tests:** `pencil draws an L` (clicks G2, G5, K5, K5 → one trail `[G2,G5,K5]`, drawing null); `pencil rejects diagonal / blocked / under-body / top-on-one-sided` (four cases, board unchanged, reason strings as above); `pencil ends on an existing trace with a joint`; `pencil adds a joint on a lead`; `erase splits and keeps joints` (trail `[A1,A9]` joints `[A1,A5,A9]`, erase A4–A5 → trails `[A1,A4]` joints `[A1]` and `[A5,A9]` joints `[A5,A9]`); `erase last segment removes the trail`; `erase never touches wires`; `toggleJoint adds then removes`; `edit functions don't mutate input` (deep-freeze the input).
- [ ] **Step 2:** `pnpm test tests/core/edit.test.ts` → FAIL.
- [ ] **Step 3:** Implement `core/edit.ts`.
- [ ] **Step 4:** `pnpm test tests/core` → PASS.
- [ ] **Step 5:** Commit `feat(core): pencil, erase and joint edit operations`.

### Task 7: CLI and the channel board 2 import

**Files:**
- Create: `cli/wirebender.ts`, `tools/import_channel_board.py`, `data/channel-board-2.wirebender.json` (generated)
- Test: `tests/core/channel-board-2.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `parseBoard`, `runCheck`.
- Produces: `pnpm check <file>` prints one line per finding grouped by severity (`ERROR`, `WARNING`, `CAUTION [supply|mcu|harmless]`), then the stats line, then the advisory sentence. Exit code: 0 no errors, 1 errors found, 2 file invalid (prints `parseBoard` errors). `--json` prints `runCheck` output as JSON instead.
- Import: `python3 tools/import_channel_board.py /Users/stakabo/Work/repos/BH/light-ctrl/re/boards > data/channel-board-2.wirebender.json`. It imports `channel_board` from that folder (add it to `sys.path`) and reads `channel_board.json` beside it. Mapping:
  - Board 18 x 24, `one-sided` (the owner can change it), `blocked: []` (the old `TOP_BLOCKED` rows are now covered by terminal bodies; NC legs become `null` pins, not blocked holes).
  - `IC_PARTS` → parts with footprints: screw terminals `terminal-2p-508`, relays `relay-g5v2`, MOSFETs `to220-gds`, U1 `dip8`, JH `header-1x5`, each with the `at`/`rotation` that reproduces the source holes exactly (the script asserts every pin hole matches; fail loudly otherwise). U1 pins 1 and 8 → `null`.
  - `TWO_LEAD` → `polyfuse-radial` (FA, FB), `axial` (RGA, RGB, RPA, RPB standing as in the source, diodes standing), `cap-disc` (C1).
  - `BARE` paths → `trails` on `bottom` with the same points; joints = every point that holds a lead plus both ends. The two-hole lift-chain links between consecutive diodes (`_br_a`, `_br_b` from `lift_chain`) → `legFolds` (cathode of diode i folded to the anode hole of diode i+1), not trails.
  - Wires from `channel_board.json` `wires` → `kind: 'flying'`, `side: 'bottom'`, points `[a.hole, b.hole]`, `bareSegments: []`; an end with `bridgeTo` adds a `solderBridges` entry `{side:'bottom', a: hole, b: bridgeTo}`.
  - Nets/classes/rules from `audit_board.py` `BOARD_CFG`: classes `GND` (from `PWR`), `HV12`, `LOGIC`; `keepAway [{a:'LOGIC', b:'HV12', holes:1}]`; `adjacency [{classes:['HV12','GND'],level:'supply'}, {classes:['HV12','LOGIC'],level:'mcu'}]`; net colours from `NET_COLORS`.
  - Pin roles from the source `pinTypes` override footprint defaults: add an optional `roles?: Record<string, PinRole>` to `Part` in `core/schema.ts` for this.

- [ ] **Step 1:** Write `tools/import_channel_board.py` and generate `data/channel-board-2.wirebender.json`. Run `python3 -c "import json;json.load(open('data/channel-board-2.wirebender.json'))"` → no error.
- [ ] **Step 2: Write the failing tests:**
  - `channel-board-2.test.ts`: file parses; 30 parts; `runCheck` has **no `openNet` and no `short`** findings (the source layout passed perfwire's audit on these rules); every `adjacent` finding with level `mcu` or `supply` is listed in a snapshot (`toMatchSnapshot()`) so changes are visible in review.
  - `cli.test.ts` (spawn `tsx cli/wirebender.ts`): channel board 2 → exit 0 or 1 consistent with the error count and stdout ends with the advisory sentence; a file with a bad hole → exit 2 and stdout contains `outside the`.
- [ ] **Step 3:** `pnpm test` → FAIL (CLI missing).
- [ ] **Step 4:** Implement `cli/wirebender.ts`.
- [ ] **Step 5:** `pnpm test` → PASS. If channel board 2 shows `openNet`/`short`, investigate the import mapping first (systematic-debugging); only change core rules if the import is proven right, and note it for the owner.
- [ ] **Step 6:** Commit `feat: CLI check and channel board 2 import`.

### Task 8: Board file server (read, atomic write, watch)

**Files:**
- Create: `server/utils/boardFile.ts`, `server/api/board.get.ts`, `server/api/board.put.ts`, `server/api/board/events.get.ts`
- Test: `tests/server/boardFile.test.ts`

**Interfaces:**
- Consumes: `parseBoard`.
- Produces:
  - Board path: env `WIREBENDER_BOARD` (absolute or relative to cwd), default `data/channel-board-2.wirebender.json`.
  - `readBoard(path): Promise<{ ok: true; board: BoardFile } | { ok: false; errors: string[] }>` (invalid JSON → `errors: ["not valid JSON: <message>"]`).
  - `writeBoard(path, board, baseRevision): Promise<{ ok: true; revision: number } | { ok: false; conflict: true; current: number }>`: re-reads the file; if its `revision !== baseRevision` → conflict; else writes `revision = baseRevision + 1` with 2-space JSON via temp file in the same folder + `rename`.
  - `watchBoard(path, onChange: (revision: number | null) => void): () => void` (chokidar; `revision` null when the file doesn't parse).
  - `GET /api/board` → 200 `{ path, board }` or 422 `{ path, errors }`. `PUT /api/board` body `{ baseRevision, board }` → 200 `{ revision }`, 409 `{ current }`, 422 `{ errors }`. `GET /api/board/events` → SSE, event `revision` with data `{ revision }` (or `{ errors: true }`) on every file change.
- [ ] **Step 1: Write the failing tests** on a temp folder: `readBoard on invalid JSON reports, doesn't throw`; `GET returns 422 with errors` (call the util the handler uses); `PUT with stale baseRevision returns 409` (write revision 3, call `writeBoard(..., 2)` → conflict current 3); `write increments revision`; `write is atomic` (no `*.tmp` left behind and the file always parses when read in a tight loop during 50 writes); `watchBoard fires on external write`.
- [ ] **Step 2:** `pnpm test tests/server` → FAIL.
- [ ] **Step 3:** Implement the util and the three handlers.
- [ ] **Step 4:** `pnpm test` → PASS. Manual: `pnpm dev`, `curl -s localhost:3000/api/board | head -c 200` shows the board.
- [ ] **Step 5:** Commit `feat(server): board file read, atomic write and live events`.

### Task 9: Both-sides board view

**Files:**
- Create: `app/components/BoardSide.vue`, `app/composables/useBoard.ts`
- Modify: `app/pages/index.vue`

**Interfaces:**
- Consumes: `/api/board`, `/api/board/events`, `placePart`, `buildConnectivity`, `holeMm`.
- Produces:
  - `useBoard()` → `{ board: Ref<BoardFile | null>, errors: Ref<string[]>, path: Ref<string>, revision: ComputedRef<number>, status: Ref<'saved' | 'saving' | 'conflict' | 'error'>, apply(next: BoardFile): void, undo(): void, redo(): void, reloadFromDisk(): Promise<void>, keepMine(): Promise<void> }`. `apply` pushes undo history and autosaves (debounced 400 ms) with `baseRevision`. On SSE `revision` greater than ours: if nothing is pending, reload; if an edit is pending or a save got 409, set `status = 'conflict'` and do not overwrite anything. On a parse error from disk, keep the last good board and show the errors.
  - `<BoardSide :board :side :mirrored :highlightNet :tool @hole-click="(hole: Hole) => …" @segment-click="(a: Hole, b: Hole) => …" @hover="(hole: Hole | null) => …" />`. SVG `viewBox` in mm with 3 mm margin; row letters and column numbers on the edges (mirrored on the mirrored side so labels stay readable). Draws: holes (pad ring on sides that have pads), part bodies at real size (solid on top; dashed ghost on bottom), pin 1 / orientation marks, leads on both sides, trails of that side as thick copper lines with round joints (a joint is a filled blob; a hole a trail only passes over shows the ring), laid wires in their colour, flying wire ends as coloured dots with the wire id, leg-folds as a short bent stroke to the target pad, solder bridges as a blob between pads, blocked holes crossed. Net colours from `nets`/`netClasses`.
  - Page layout: header (icon, WireBender, board name, file path, `rev N`, status chip), toolbar row, then **top and bottom side by side** (bottom mirrored by default; a `Mirror bottom` switch; key `F` swaps to a single large view of the other side for small screens), findings panel on the right.
  - Hover a hole → tooltip with hole name, part pin if any, net; the whole group of that hole is highlighted on both sides.
- [ ] **Step 1:** Implement `useBoard` and `BoardSide`, render channel board 2 in `index.vue`.
- [ ] **Step 2:** `pnpm typecheck` → no errors; `pnpm test` → PASS.
- [ ] **Step 3: Verify in the browser** (claude-in-chrome, `pnpm dev`): both sides visible; relay, TO-220, terminals and header bodies at real size; `G13`-style labels correct (check U1 pin 6 sits at the hole channel_board.py says); bottom side mirrored; hovering `JH` pin 2 highlights the IN_A group on both sides. Screenshot to the owner.
- [ ] **Step 4: Verify live sync:** with the page open, change a net colour in the data file with a text edit → page updates within ~1 s, `rev` unchanged by external edits that don't touch `revision`… (external edits keep whatever `revision` they write; the page reloads on any change). Write invalid JSON → error banner, last good board still shown; fix it → banner gone.
- [ ] **Step 5:** Commit `feat(app): both-sides board view with live file sync`.

### Task 10: Tools, findings panel and conflict banner

**Files:**
- Create: `app/components/Toolbar.vue`, `app/components/FindingsPanel.vue`, `app/composables/useTools.ts`
- Modify: `app/pages/index.vue`

**Interfaces:**
- Consumes: `pencilClick`, `eraseSegment`, `toggleJoint`, `runCheck`, `useBoard`.
- Produces:
  - `useTools()` → `{ tool: Ref<'inspect' | 'pencil' | 'erase' | 'joint'>, drawing: Ref<Drawing | null>, message: Ref<string | null>, onHoleClick(side, hole), onSegmentClick(side, a, b) }`. A rejected edit shows its `reason` in a toast (Nuxt UI `useToast`) and changes nothing. `Esc` ends the current drawing. Keys: `I` inspect, `P` pencil, `E` erase, `J` joint, `Ctrl/Cmd+Z` undo, `Shift+Ctrl/Cmd+Z` redo. While drawing, a rubber-band line follows the pointer from the last point, snapped to its row/column.
  - The side a click lands on is the side being edited (clicking the bottom panel draws on the bottom).
  - `FindingsPanel`: `runCheck(board)` recomputed on every board change (computed); grouped Errors / Warnings / Cautions, cautions sub-grouped `Shorts the supply`, `Kills the MCU`, `Harmless` (harmless collapsed by default); clicking a finding highlights its holes on both sides; footer shows the advisory sentence. Proposed joints (`missingJoint`) have an `Add joint` button that applies `toggleJoint`.
  - Conflict banner (when `status === 'conflict'`): "The board file changed on disk while you were editing." Buttons: `Load the file` (`reloadFromDisk`, discards local edits after a confirm in the banner itself, no browser dialog) and `Keep my version` (`keepMine`: saves with the current disk revision as base, so the file gets the owner's board with a new revision).
- [ ] **Step 1:** Implement `useTools`, `Toolbar`, `FindingsPanel`, and the banner.
- [ ] **Step 2:** `pnpm typecheck` and `pnpm test` → PASS.
- [ ] **Step 3: Verify in the browser** (record a GIF with gif_creator, `wirebender_m1_tools.gif`): draw an L trail on the bottom with the pencil, end it with a double click on the last hole; erase its middle segment → two trails; toggle a joint; undo three times → original board; try a diagonal click → toast with the reason; draw a trail across another net's leg → `Short` appears in Errors and highlights the holes. Then from the terminal change the file (e.g. with `pnpm check`'s neighbour: edit a trail point by hand) while an edit is pending → conflict banner appears, both buttons behave as described.
- [ ] **Step 4:** Run `pnpm check data/channel-board-2.wirebender.json` after editing in the browser → the CLI output matches the findings panel counts.
- [ ] **Step 5:** Commit `feat(app): pencil, erase and joint tools with live check and conflict handling`.

---

## After this plan

Milestone 1 is done when the owner has opened channel board 2, redrawn at least one trail
in the browser, and the CLI and panel agree. Next plans, in the owner's order: bench
export (spec §6), then 3D view (spec §5).
