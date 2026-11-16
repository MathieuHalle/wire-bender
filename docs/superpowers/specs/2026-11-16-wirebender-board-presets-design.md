# WireBender: board presets — design (short)

## Intent

Starting a board means typing its size and copper sides every time. The owner wants the boards
they actually use one click away: the cheap blank prototype boards they buy, and connector
"boards" such as the CHOGORI 22004515 4-pin panel connector, whose solder tails are treated as a
2 × 2 board with a `+` pin and a `-` pin. First of three (owner, 2026-11-16): presets now, other
board shapes next, stripboard (Veroboard) as its own project after.

## Goals

- "New board" offers a **preset** menu. Choosing one fills in the size, pitch and sides, and may
  start the board with parts and nets (the connector's `+` / `-` header). **Custom** keeps today's
  fields (columns, rows, one- or two-sided, 2.54 mm) and is the default.
- `POST /api/boards` accepts `{ "name", "preset" }` beside today's `{ "name", "cols", "rows", "type" }`
  (which stays as it is). An unknown preset is a `422` that lists the preset names.
- Presets may include **blocked holes** (`board.blocked`, already in the format: "mounting holes,
  cut-outs"), so a board with holes is a preset like any other.

## Non-goals

- Users' own templates (owner chose built-in presets; duplicating a board remains the way to
  reuse one's own).
- Other outlines (round, cut corners): the next project. Stripboard / breadboard (strips joined
  per row): its own project.
- Mounting holes on the blank boards: on these boards they sit outside the hole grid.
- Any change to the board file format (`wirebender/1`): a preset only produces an ordinary board.

## Anti-goals

- A preset that makes a board `parseBoard` rejects. Every preset is checked by a test.
- Two lists of presets (the app's and the server's) that can drift: one list, in `core/`.

## Approaches

1. **A list in code in `core/boardPresets.ts` (picked by the owner).** Typed, tested, shared by
   the app, the server and any CLI or MCP use; a typo fails a test, not a server start.
2. Preset board files in a folder the server reads: addable without code, but untyped data
   validated at start, and a full board file per preset.
3. Users' own templates (mark a board as one): more flexible, but stored state, a menu item and
   per-user lists; set aside earlier by the owner.

## The presets (v1)

| id | Name | cols × rows | pitch | sides | Starts with |
|---|---|---|---|---|---|
| `custom` | Custom | the form's | 2.54 | the form's | nothing (today's behaviour) |
| `proto-4x6` | Prototype board 4 × 6 cm | 14 × 20 | 2.54 | two-sided | nothing |
| `proto-5x7` | Prototype board 5 × 7 cm | 18 × 24 | 2.54 | two-sided | nothing |
| `proto-7x9` | Prototype board 7 × 9 cm | 26 × 31 | 2.54 | two-sided | nothing |
| `chogori-22004515` | CHOGORI 22004515 4-pin connector | 2 × 2 | 2.54 | one-sided | `J1` (`header-2x2` at A1, value `CHOGORI 22004515-01`), pin 1 `+` (`#d62839`), pin 2 `-` (`#222222`) |

Hole counts: 5 × 7 cm (432 holes) and 7 × 9 cm (806 holes) from sellers' listings; **4 × 6 cm
(14 × 20) is unconfirmed**: the owner counts one before release. The connector's real pin
spacing is not on its drawing; 2.54 mm keeps the header drawn right, and the spacing does not
change the wiring.

## How (my calls, for the owner to check)

- **Rotation 0 for every preset's parts**, as placed above; a preset's parts and nets are copied
  as they are, the board's `name` is the one typed in the form.
- **The form:** a preset menu above the size fields; with a preset chosen, the size and sides show
  what it sets, read-only; Custom makes them editable again.
- **The API docs:** the route row for `POST /api/boards` in the README and on the Connections page
  (kept in step) names `preset` and lists the ids.
- **Ids are stable** (`proto-5x7`, not the display name), so scripts keep working if a name is
  reworded.

## Left to the builder

- The `BoardPreset` type and where `emptyBoard` takes a preset (`server/utils/api.ts`).
- How the form shows a read-only size (disabled fields, or a line of text).
- Tests: every preset passes `parseBoard`; the API creates from a preset and refuses an unknown
  one; Custom still works.
