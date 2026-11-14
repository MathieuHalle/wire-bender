# WireBender: moving parts and wires in the editor — design

## Intent

Today the editor cannot change a part or a wire: it draws, cuts and joints trails, and parts
and wires come only from Claude (the API / MCP). The owner wants to move them by hand, both
while laying a board out and on a board that is already wired. The main spec lists "dragging
parts in the editor" as planned later (§2, non-goals v1); this is that, plus wires.

## Goals

- A **Move** tool in the 2D editor: pick up a part or a wire with a click, see a copy of it
  follow the pointer (snapped to the nearest hole), set it down with a second click.
- While a part or a whole wire is held, rotate it in 90° steps.
- On a wire, a click on an end hole picks up only that end, to re-land it (typically on a pin
  of a part that was just moved); a click anywhere else on it picks up the whole wire.
- A laid wire's end moved out of line with its previous point gets an automatic L-bend, shown
  in the copy before it is set; Tab switches which way the L goes.
- Every placement is one ordinary edit: one revision, one undo step, seen live by every open
  copy (iPad included).

## Non-goals

- Wiring following a moved part. Trails and wires stay exactly where they were drawn
  (owner: "I don't mind if the flat wire and trace don't follow").
- Editing in 3D: the 3D view stays look-only.
- Moving trails (they are drawn and cut with the pencil and erase tools), solder bridges, or
  joints on their own.
- Adding, deleting, flipping or standing parts, changing a part's value, label or pin nets.
- Selecting or moving several things at once.

## Anti-goals

- Any change to wiring the owner did not pick up. Only the held wire changes, and only as the
  copy showed it. In particular, a part set down on trails or wires gets **no** joints added
  (unlike the pencil, which adds joints where a new run crosses a lead): what isn't soldered
  stays unsoldered, and the check reports it.
- A placement that differs from the copy shown at the moment of the click.
- Picking something up by accident: picking happens only in the Move tool.
- Claiming a board is safe to power. Findings stay advisory and recompute after a move as
  after any edit.

## Constraints

- The rules live in `core/` (no Vue, Nuxt, Node or DOM), next to `pencilClick`,
  `eraseSegment` and `toggleJoint` in `core/edit.ts`, returning `EditResult`. The UI and any
  future CLI call the same functions.
- "On top of another part" means what the check already means (`core/check/placement.ts`,
  using `placePart` from `core/footprints.ts`): a placement is refused when, for the moved
  part, it would create a `bodyCollision` with another part, a lead sharing a hole with
  another part's lead (`twoInOneHole`), or a lead under another part's body or another
  part's lead under its body (`underBody`, part against part only). **Only new conflicts
  count:** a conflict between the same two parts, by the same rule, that the board already had
  before the move does not refuse it, so a part placed overlapping through the API can still
  be nudged and moved out. Wires, trails and findings that involve them never block a
  placement.
- A placement is also refused when any **pin** or **wire point** would leave the board (the
  check's `Off the board` rule). A part's **body may hang over the edge**, as edge terminals,
  jacks and relays do on real boards; the check does not flag that today either.
- A placement is refused when a pin, a wire point or a moved wire end would land on a
  **blocked hole** (`board.blocked`), with the blocked hole's reason, as the pencil refuses
  them today (`rejection()` in `core/edit.ts`). A body over a blocked hole is fine.
- The board format does not change (`wirebender/1`): a move rewrites `at`, `to` and
  `rotation` of a part and the `to` of its own leg folds (`legFolds` whose `lead` is one of
  its pins), or `points` / `joints` / `bareSegments` of a wire.
- Laid wires keep the format's rule that every step runs along a row or a column
  (`checkStraight` in `core/schema.ts`). Flying wires have no such rule.
- Locked boards (the 3D view, a board that is not live, a view-only role) get no Move tool
  and no pick-ups, like the other edit tools today.

## Approaches

1. **Rules in `core/edit.ts`, a Move tool in `useTools`, the copy drawn by the 2D side
   (picked).** Three pure functions (move a part, move a whole wire, move one wire end) take
   the board and the target and return the new board or a reason. The same functions tell the
   UI, on every pointer move, whether the spot is allowed, so the red copy and the click can
   never disagree. `useTools` holds the pick-up state; the board side draws the copy. A
   placement is one `apply`. Fits the project's rule of one rule engine shared by UI and CLI,
   and is unit-testable without a browser.
2. **Rules inside the Vue components.** Quicker to start, but a second copy of placement rules
   outside `core/` (the anti-goal of two rule engines in the main spec), and the allowed/red
   logic untestable without a browser.
3. **A server endpoint for moves.** Nothing to gain: edits already go live from the page, and a
   round trip per pointer move would lag.

## How it works (as decided with the owner)

### The tool

- **Move, key `M`**, beside Navigate, Inspect, Pencil, Erase and Joint (H I P E J). It appears
  in the toolbar with the others and in the keys line under the canvas.
- In the Move tool, a click on a part or a wire picks it up. A click on empty board does
  nothing.
- Parts are picked up in the **top** view only (the parts side). A wire is picked up in the
  view of its own side (a bottom wire in the bottom view).

### Holding something

- A copy of the held thing follows the pointer, snapped to the nearest hole. The original
  stays drawn where it is, dimmed, until the placement.
- The copy is drawn normally when the spot is allowed and **red** when it is not; the line
  under the canvas (where the drawing hint goes today) says what is held and, when red, why
  (for example "R3 would overlap U2" or "off the board").
- **Click** sets it down, if allowed. On a red spot the click does nothing and the reason
  stays shown.
- **Esc** puts it back: nothing changes.
- **Rotate** (parts and whole wires only): `R` and `→` rotate 90° clockwise, `←` 90°
  counter-clockwise. `R` because KiCad, EasyEDA and Fritzing use it; the arrows because the
  owner asked for them.

### Parts

- The part keeps its pins' nets, value, label, flip and standing. Only where it sits changes.
- **Its leg folds go with it.** A fold (`legFolds`: a leg left long and bent onto a nearby
  hole) is part of the part, not wiring the owner drew: its `to` hole moves and rotates with
  its leg, keeping the same offset from it. If the folded-to hole would be off the board or
  blocked, the spot is red.
- Its old pin holes keep whatever wiring was there; its new pin holes get no joints. The check
  then shows what is no longer connected, or newly shorted, as it would for any edit.

### Wires

- **Whole wire:** it moves as one piece, keeping its shape, bends, bare stretches and joints;
  it rotates like a part.
- **Click on an end hole** (the wire's first or last point): only that end is held. The rest
  of the wire stays where it is.
- **Click anywhere else on the wire** (a hole it passes, or its drawn line between holes):
  the whole wire is held. So every wire, a 2-hole jumper included, can be moved whole (by its
  line) or by one end (owner, 2026-11-13).
  - The joint at that end, if it has one, moves with the end. Other joints stay.
  - **Flying wire:** the end goes to any hole on the board.
  - **Laid wire:** if the new end is in line (same row or column) with the point before it,
    that run just gets longer or shorter. If not, one corner is added so the wire goes
    along the row first, then the column (an L), shown in the copy. **Tab** switches to
    column first, then row. The L's two runs are bare if the run they replace was bare.
  - A spot that would make the end land on the point before it (a run of length 0) is red.
  - **Shortening drops what the wire no longer reaches:** joints on holes the wire no longer
    passes, and bare stretches past the new end, are removed with the run. The copy shows the
    result (a dropped joint disappears from the copy), so nothing changes that wasn't shown.
- Wires may be set down on other wires, on trails and on pins: overlapping insulated wires are
  allowed today, and the keep-away and short checks report what needs a look.

### Live editing

- Placement applies to the board as it is at the moment of the click, by the part's `ref` or
  the wire's `id`.
- If someone else changes or deletes the held part or wire while it is held, it is dropped
  (as with Esc) and a message says so ("R3 was changed on another device; pick it up again").

## My calls (mark for the owner)

- **The Move tool and key `M`**, so a stray click while drawing never picks anything up.
- **`R` as the main rotate key**, with `←` / `→` as the owner asked.
- **The hole you click stays under the pointer** while you move (the copy keeps that offset),
  and rotation turns around that hole.
- **Only new part-against-part conflicts refuse a placement**, so existing overlaps can be fixed by moving.
- **A part's body may overhang the board edge**; pins and wire points may not.
- **Blocked holes refuse pins, wire points and wire ends**, as the pencil does.
- **Leg folds move with their part.**
- **A shortened laid wire loses the joints and bare stretches it no longer reaches**, shown in the copy.
- **No joints are added** when a part lands on wiring (see Anti-goals).
- **On the iPad (no keyboard):** while something is held, a small bar near the copy gives
  **Rotate**, **Switch bend** (laid-wire ends only), **Place** and **Cancel**. With touch there
  is no hover: a tap on a hole moves the copy there, and **Place** (or a second tap on the
  same hole) sets it down.

## Left to the builder

- Function names and signatures in `core/edit.ts`, and how the "is this allowed" answer is
  shared with the UI (one function used both for the preview and for the click).
- How a two-lead part with `to` rotates (its span turns 90° about the held hole), consistent
  with how `placePart` already interprets `at`, `to` and `rotation`.
- How `bareSegments` indices shift when a corner is added at the first end of a wire.
- Which of overlapping things a click picks (a wire drawn over a part, say): the one drawn on
  top.
- How the copy and the dimmed original are drawn (in `app/components/board/`), and the
  toolbar icon.
- Tests: the core rules (allowed and refused cases for parts, whole wires, flying and laid
  ends, both L directions, rotation, off-board, collisions), the tool state in `useTools`
  (pick, rotate, Tab, Esc, place, dropped by a remote change), and a browser check on a test
  board.
