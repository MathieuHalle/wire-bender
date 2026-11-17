# WireBender: board shapes — design (short)

## Intent

Boards are rectangles of holes today. The owner builds round boards (the CHOGORI connector's
solder tails, round enclosures) and boards with cut corners, and wants to draw them as they are:
the outline as cut, and no holes where the board isn't. Second of three (owner, 2026-11-16):
presets (done, v0.2.2), shapes now, stripboard later. The owner said "round boards and corner
cuts, just dive in": the calls below are mine, marked for the owner to check.

## Goals

- An optional `board.shape` in the board file: **round**, or a rectangle with **corner cuts**
  (each corner: a 45° **chamfer** or a square **notch**, N holes deep). Without it, today's
  rectangle; old files are unchanged and stay valid.
- Holes outside the shape are **missing**: not drawn (2D, 3D, exports), refused by the pencil and
  the Move tool like off-board holes, and reported by the check when a part's pin, a trail or a wire
  point is on one ("Off the board").
- The outline is drawn as it is: 2D sides, 3D board, bench sheet / SVG overview.
- "New board" and the API can make one; the CHOGORI preset becomes round.

## Non-goals

- Arbitrary outlines (any polygon), holes or slots inside the board (blocked holes cover that), an
  ellipse, a circle not centred on the grid, a diameter of its own. Stripboard (next project).
- Changing a board's shape after it is made, in the app (the API's PUT of a whole board can).

## Anti-goals

- A board that existed before becoming invalid. Items on missing holes are check findings, never
  a parse error, so a board whose shape is changed through the API still opens.
- A hole drawn that the tools refuse, or the other way round: one `holeExists` decides for all.

## Approaches

1. **A shape field plus one `core/boardShape.ts` (my call).** `holeExists(board, hole)` and
   `boardOutline(board)` in `core/`; every place that tests `cols`/`rows` (mapped in the session)
   asks them instead. Small format addition, one rule for drawing, tools and checks.
2. **Shapes as generated blocked holes.** No format change: a round board is a rectangle whose
   outside holes are `blocked`. But the outline cannot be drawn (blocked holes are drawn crossed,
   and there are many), the reason text is noise, and the shape is lost once edited.
3. **A full outline polygon in the file.** Covers every shape, but the owner asked for two; a
   polygon editor and its rules are a project of their own.

## The format (my calls)

```json
"board": { "cols": 10, "rows": 10, "pitchMm": 2.54, "type": "one-sided", "blocked": [],
           "shape": { "kind": "round" } }
"shape": { "kind": "corners", "corners": { "topLeft": { "cut": "notch", "holes": 2 }, "bottomRight": { "cut": "chamfer", "holes": 3 } } }
```

- **Round:** a circle centred on the middle of the grid, diameter `min(cols, rows) × pitch` (the
  rectangle's own side, half a pitch past the outer holes).
- **Corners:** any of `topLeft`, `topRight`, `bottomLeft`, `bottomRight`; `holes` is a whole
  number ≥ 1. A **notch** removes the `holes × holes` block of holes at that corner; a **chamfer**
  removes the holes nearer the corner than a 45° line (`holes` = 1 removes the corner hole,
  2 removes 3). Corners are as drawn on the top side (row A at the top, column 1 at the left).
- **A hole exists** when it is in the `cols × rows` grid and its centre is at least **¼ pitch**
  inside the outline. (A 2 × 2 round board keeps its 4 holes; a 10 × 10 one loses its corners.)
- Schema rules: two cuts on the same edge leave at least one hole on that edge (their `holes`
  add up to less than the edge's holes).
- **Missing holes form a run at the start or end of each row and column** (all three cuts are
  convex per row and column), so a straight run between two existing holes never crosses a
  missing one: the pencil only checks the clicked points, as today.

## What changes where (from the session's map)

- `core/boardShape.ts` (new): `holeExists`, `existingHoles`, `boardOutline` (a circle, or a
  polygon in board mm), `outlinePoints` (the circle as a polygon, for 3D).
- Tools: `core/edit.ts` `rejection`, `core/move.ts` (pins, folds, wire points, the target, and the
  L-bend's corner hole, which today has no bounds check), `app/utils/movePointer.ts` `hoverHole`,
  `useTools` `onMoveClick`, `BoardSide.vue` `inBoard` / the rubber band.
- Check: `core/check/context.ts` `onBoard` → `holeExists`; the "Off the board" rule also covers
  trail points, wire points and leg-fold holes (today only part pins).
- Drawing: `Holes.vue` (outline path, missing holes left out), `core/scene3d/board.ts` and
  `scene3dThree.ts` (shaped slab by extrusion, holes and pads filtered, the label pitch passed in
  rather than guessed from the first two holes), `export/svg.ts` (outline, holes).
- Edge labels stay along the bounding rectangle (a round board keeps its 1..cols / A..rows).
- Format docs (`wirebender-1.md`, the generated JSON schema), "New board" (a Shape choice:
  rectangle, round, chamfered or notched corners with a size, applied to all four), the API body
  (`shape` passed through), the CHOGORI preset (`round`).

## Left to the builder

- Function signatures; how the outline path is built; 3D circle segment count.
- Tests: `holeExists` for each cut and round sizes (2 × 2, 10 × 10, odd sizes), the schema rule,
  tools refusing missing holes, the check's findings, the drawn hole counts.
