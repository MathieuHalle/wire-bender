# Board presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "New board" and `POST /api/boards` can start a board from a built-in preset (blank prototype boards, the CHOGORI 4-pin connector).

**Architecture:** One list in `core/boardPresets.ts` builds ordinary `wirebender/1` boards. The server's
`createOrImport` takes `{ name, preset }` beside today's `{ name, cols, rows, type }`; the form picks a
preset through a small pure helper in `app/utils/newBoard.ts`.

**Tech Stack:** TypeScript, Nuxt 4 / Vue 3 / Nuxt UI, Vitest (Node).

**Spec:** `docs/superpowers/specs/2026-11-16-wirebender-board-presets-design.md`

## Global Constraints

- `core/` has no Vue, Nuxt, Node or DOM imports.
- No change to the board file format (`wirebender/1`); every preset passes `parseBoard`.
- One list of presets, in `core/`; ids are stable: `custom`, `proto-4x6`, `proto-5x7`, `proto-7x9`, `chogori-22004515`.
- Today's `{ "name", "cols", "rows", "type" }` keeps working unchanged (2.54 mm).
- The README route table and the Connections page's `ROUTES` stay in step (`app/pages/settings/connections.vue` says so).
- Verification: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## Review Focus

1. `{ name, preset }` with a blank or missing name: the same `422` `name: must be a non-empty string` as today. Test in Task 2.
2. A body with both `preset` and `cols`/`rows`/`type`: the preset decides; the extra fields are ignored. Test in Task 2.
3. `preset` that is not a string (a number, `null`): `422` naming the valid ids, nothing created. Test in Task 2.
4. In the form, choosing a preset and then Custom again gives back editable size fields holding the
   Custom values from before (not the preset's). Test in Task 3.
5. Two presets with the same id would make one unreachable. Test in Task 1 (ids unique).

---

### Task 1: The preset list in `core/`

**Files:**
- Create: `core/boardPresets.ts`
- Test: `tests/core/boardPresets.test.ts`

**Interfaces:**
- Produces:
  - `export type BoardSides = 'one-sided' | 'two-sided'`
  - `export function blankBoard(name: string, size: { cols: number, rows: number, pitchMm: number, type: BoardSides }): BoardFile` — the empty board `emptyBoard` builds today (format, revision 0, empty nets, rules, parts, trails, wires, legFolds, solderBridges, `blocked: []`).
  - `export interface BoardPreset { id: string, name: string, cols: number, rows: number, pitchMm: number, type: BoardSides, nets?: BoardFile['nets'], parts?: Part[], blocked?: BoardFile['board']['blocked'] }`
  - `export const BOARD_PRESETS: BoardPreset[]` — the four non-custom presets, in the spec's order.
  - `export const PRESET_IDS: string[]` — `['custom', ...BOARD_PRESETS ids]`.
  - `export function presetBoard(id: string, name: string): BoardFile | null` — `null` for an unknown id and for `custom` (Custom has no fixed size).

- [ ] **Step 1: Write the failing tests**

```ts
it('every preset is a valid board, named as asked', () => {
  for (const p of BOARD_PRESETS) {
    const b = presetBoard(p.id, 'My board')!
    expect(parseBoard(b).ok).toBe(true)
    expect(b.name).toBe('My board')
  }
})
it('the ids are unique and stable', () => {
  expect(PRESET_IDS).toEqual(['custom', 'proto-4x6', 'proto-5x7', 'proto-7x9', 'chogori-22004515'])
  expect(new Set(PRESET_IDS).size).toBe(PRESET_IDS.length)
})
it('sizes and sides as the design lists them', () => {
  expect(presetBoard('proto-4x6', 'x')!.board).toEqual({ cols: 14, rows: 20, pitchMm: 2.54, type: 'two-sided', blocked: [] })
  expect(presetBoard('proto-5x7', 'x')!.board).toMatchObject({ cols: 18, rows: 24, type: 'two-sided' })
  expect(presetBoard('proto-7x9', 'x')!.board).toMatchObject({ cols: 26, rows: 31, type: 'two-sided' })
})
it('the connector starts with J1: pin 1 + (red), pin 2 - (black)', () => {
  const b = presetBoard('chogori-22004515', 'Cable 1')!
  expect(b.board).toEqual({ cols: 2, rows: 2, pitchMm: 2.54, type: 'one-sided', blocked: [] })
  expect(b.parts).toEqual([{ ref: 'J1', footprint: 'header-2x2', at: 'A1', rotation: 0, value: 'CHOGORI 22004515-01', pins: { 1: '+', 2: '-', 3: null, 4: null } }])
  expect(b.nets).toEqual({ '+': { color: '#d62839' }, '-': { color: '#222222' } })
})
it('custom and unknown ids give no board', () => {
  expect(presetBoard('custom', 'x')).toBeNull()
  expect(presetBoard('nope', 'x')).toBeNull()
})
it('blankBoard is the empty board of that size', () => {
  const b = blankBoard('Blank', { cols: 10, rows: 8, pitchMm: 2.54, type: 'two-sided' })
  expect(parseBoard(b).ok).toBe(true)
  expect(b).toMatchObject({ name: 'Blank', parts: [], wires: [], trails: [], board: { cols: 10, rows: 8, blocked: [] } })
})
```

- [ ] **Step 2: Run** `pnpm vitest run tests/core/boardPresets.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `core/boardPresets.ts` with the values above (presets copy their `parts`, `nets`, `blocked` so a caller cannot change the list).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(core): board presets`

### Task 2: `POST /api/boards` takes a preset

**Files:**
- Modify: `server/utils/api.ts` (`emptyBoard`, `createOrImport`)
- Modify: `README.md` (the `POST /api/boards` row), `app/pages/settings/connections.vue` (same row in `ROUTES`)
- Test: `tests/server/api.test.ts` (`describe('create and import')`)

**Interfaces:**
- Consumes: `blankBoard`, `presetBoard`, `PRESET_IDS` (Task 1).
- Produces: body `{ "name", "preset" }`. Rule: `preset` present and not `'custom'` → `presetBoard(preset, name)`; otherwise today's path (`emptyBoard`, which now calls `blankBoard` with `pitchMm: 2.54`). Unknown or non-string preset → `422` with the error `preset: must be one of custom, proto-4x6, proto-5x7, proto-7x9, chogori-22004515`.

- [ ] **Step 1: Write the failing tests** — `{ name: 'Cable', preset: 'chogori-22004515' }` → 200, the stored board has `J1` and 2 × 2; `{ name: 'B', preset: 'proto-5x7', cols: 3, rows: 3, type: 'one-sided' }` → 18 × 24 two-sided (Focus 2); `{ name: 'B', preset: 'nope' }`, `{ name: 'B', preset: 7 }`, `{ name: 'B', preset: null }` → 422 with that exact error and no board created (Focus 3); `{ name: '  ', preset: 'proto-5x7' }` → 422 `name: must be a non-empty string` (Focus 1); `{ name: 'B', preset: 'custom', cols: 4, rows: 3, type: 'one-sided' }` → 4 × 3, as today.
- [ ] **Step 2: Run** `pnpm vitest run tests/server/api.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `createOrImport` / `emptyBoard`; update both route rows to: `` `{ "board": <board json> }` imports; `{ "name", "cols", "rows", "type" }` creates an empty board, or `{ "name", "preset" }` one from a preset (`proto-4x6`, `proto-5x7`, `proto-7x9`, `chogori-22004515`); answers `{ id }` ``.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(server): create a board from a preset`

### Task 3: The preset menu in "New board"

**Files:**
- Create: `app/utils/newBoard.ts`
- Modify: `app/components/NewBoardModal.vue`
- Test: `tests/app/newBoard.test.ts`

**Interfaces:**
- Consumes: `BOARD_PRESETS`, `BoardSides` (Task 1).
- Produces:
  - `export interface NewBoardDraft { name: string, preset: string, cols: number, rows: number, type: BoardSides }` — `cols`/`rows`/`type` hold the **Custom** values; a preset never overwrites them (Focus 4).
  - `export function newBoardBody(d: NewBoardDraft): { name: string, preset: string } | { name: string, cols: number, rows: number, type: BoardSides }` — Custom sends today's body; a preset sends `{ name, preset }`.
  - `export function shownSize(d: NewBoardDraft): { cols: number, rows: number, type: BoardSides, fixed: boolean }` — the preset's size (`fixed: true`) or the draft's Custom values (`fixed: false`).
  - `export const PRESET_ITEMS: { label: string, value: string }[]` — `Custom` first, then each preset's `name`.

- [ ] **Step 1: Write the failing tests** — `newBoardBody` for Custom → `{ name, cols, rows, type }`; for `proto-7x9` → `{ name, preset: 'proto-7x9' }`; `shownSize` for `chogori-22004515` → `{ cols: 2, rows: 2, type: 'one-sided', fixed: true }`; a draft `{ preset: 'proto-5x7', cols: 12, rows: 9, type: 'one-sided' }` set back to `custom` → `shownSize` `{ cols: 12, rows: 9, type: 'one-sided', fixed: false }` (Focus 4); `PRESET_ITEMS[0]` is `{ label: 'Custom', value: 'custom' }` and has 5 items.
- [ ] **Step 2: Run** `pnpm vitest run tests/app/newBoard.test.ts` → FAIL.
- [ ] **Step 3: Implement** `app/utils/newBoard.ts`; in the modal: a `USelect` "Board" above the size (items `PRESET_ITEMS`, default `custom`), the Columns / Rows / Copper fields bound to the draft but `:disabled` and showing `shownSize` when `fixed`; Create posts `newBoardBody(draft)`.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Browser check** on a scratch server (own data dir, port 3125, local mode): "New board" → pick "CHOGORI 22004515 4-pin connector" → the size shows 2 × 2 one-sided, disabled → Create opens a 2 × 2 board with J1; Custom 10 × 6 still creates 10 × 6.
- [ ] **Step 6: Commit** `feat(app): presets in "New board"`
