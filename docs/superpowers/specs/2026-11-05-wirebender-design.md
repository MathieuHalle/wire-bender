# WireBender: design

Date: 2026-11-05 · Status: approved by the owner (2026-11-05) · Name: WireBender

## 1. Intent

A tool for planning hand-soldered prototype boards on perfboard, so the board can be
"played with" and approved **before** the bench, and so the bench gets sheets that make
the hard part (cutting, stripping and bending wire and bare trails) easy.

The owner builds prototype boards by hand, for themself. It will be open source, but
the first and only user that matters for now is the owner. First real target:
**channel board 2** of the light-ctrl project (5 x 7 cm, 18 columns x 24 rows), ASAP.
Boards 3-5 use the same layout, so the tool should pay off on those too.

### Why

On channel board 1 the plan was made with [perfwire](https://github.com/KeckuJp/perfwire)
plus our own Python scripts, and printed instruction sheets. It worked, but:

- There was no way to play with the board before building it. About 75% of the
  on-the-spot changes at the bench came from seeing a simpler or easier-to-solder route
  with the parts in hand. Those can't all be planned in advance, but more of them can be
  caught on screen and by dry-fitting parts at the desk.
- Perfwire shows only one side at a time, its editing tools are hard to use, and the
  automatic "Rewire" throws away hand-made wiring.
- Bare trails were stored as one bridge per pair of adjacent holes, which made bench
  instructions unusable; our own scripts had to rebuild them.
- Full list of perfwire pain points: `light-ctrl/re/boards/perfwire-notes.md`.

### The workflow it supports

1. Pick the board: size, one or two sides, blocked zones (mounting holes, obstacles,
   unusable holes).
2. Place the parts (v1: Claude does it, in the board file).
3. Automatic first draft of the wiring (v1: Claude does it, in the board file).
4. Wiring preview in the browser. The owner looks at both sides, redraws trails they
   don't like with a pencil tool, and dry-fits real parts at the desk. Claude re-checks.
5. Repeat 2-4 until the technical check is clean and the owner approves it by eye
   ("eye review + gut feeling"), with a final look in 3D.
6. Export the bench sheets: printed 1:1, and/or one offline HTML file for phone or iPad.
7. Place and solder. Changes made on the spot are written on paper and told to Claude
   afterwards, who updates the board file (no bench-side input form).

## 2. Goals, non-goals, anti-goals

### Goals (v1)

- Model a real perfboard build faithfully: real part bodies, one leg per hole, both
  sides, bare trails as paths, insulated wires, leg-fold bridges, solder joints.
- A browser view that shows **both sides** and lets the owner **redraw trails** easily.
- The technical check always runs on the wiring **as drawn**, and never replaces it.
- Bench sheets that are usable without thinking: cut, strip, bend, place, solder, test.
- Claude and the owner work on the same file; the browser updates when Claude edits it.

### Non-goals (v1, planned later)

- Automatic placement and routing inside the tool (Claude does them by hand in v1).
- Importing from KiCad / EasyEDA, and sending the schematic back to them.
- Real 3D models from an online parts database (for example EasyEDA / LCSC).
- Dragging parts in the editor.
- Stripboard, breadboard, or ordering a manufactured PCB.

### Anti-goals (would make it a failure even if it works)

- Any action that silently replaces or rewrites wiring the owner drew.
- An autosave or reload that silently shows an older version of the board.
- A bench sheet that needs the computer to understand, or a 1:1 print that is not 1:1.
- A bench-side form for recording changes (explicitly out of scope).
- Claiming a board is safe to power. The check is advisory; the meter test list is the
  owner's own pre-power check.
- Two copies of the rule engine that have to be kept in sync (perfwire's main
  maintenance cost).

## 3. Board model

One file per board, in the project folder, readable and editable by hand and by Claude.
Exact format is the builder's call (JSON is fine); the concepts are fixed:

- **Board**: columns x rows, hole pitch 2.54 mm, board outline and size in mm,
  one-sided or two-sided, blocked holes and blocked zones (with a reason: mounting hole,
  under a heatsink, keep clear...). Hole names are row letter + column number, as on
  the channel board: `G13` = row G, column 13 (row A at the top).
- **Sides**: `top` (parts side) and `bottom` (solder side). Every trail and wire is on one
  side. The bottom side is drawn mirrored by default, so it matches the board turned over
  in the hand (with a toggle for unmirrored).
- **Board type** (the owner has both kinds): **one-sided** (pads on the bottom only) or
  **two-sided, not plated** (pads on both sides, but the two pads of a hole are *not*
  connected to each other). The two sides of a hole are only connected when a leg or a
  wire end goes through that hole and is soldered on both sides. On a one-sided board,
  nothing can be soldered on the top side; a top-side bare run is only a wire that goes
  down through holes to be soldered underneath.
- **Footprints**: a small built-in library of real parts, each with pin positions,
  a real body outline (what holes and space it covers, on which side, how tall) and a
  pin 1 / orientation mark. v1 must cover what channel board 2 uses:
  G5V-2 relay, TO-220 (IRLB3813, with tab), DIP-8 (TC4426), 2-position 5.08 mm screw
  terminal (covers two rows), 1x5 2.54 mm header, polyfuse (MF-R110), lying and standing
  axial parts (resistors, 1N4001 at 2.7 mm wide), ceramic disc capacitor.
- **Parts**: an instance of a footprint at a position with a rotation (0/90/180/270)
  and an optional flip, a reference (`U1`), a value/label, and a net for each pin.
  Unused pins (NC) are physical legs with no net and must not produce warnings.
- **Nets**: name plus a **net class** (for channel board 2: `GND`, `HV12` for anything
  that can sit at 12 V, `LOGIC` for the 3.3 V lines from the Pico). Classes and
  keep-away rules between classes live in the board file, not in code.
- **Trails** (bare wire): an ordered list of holes (the bend points), on one side.
  Between two consecutive points the trail runs straight along a row or column.
  It passes over the holes in between without being soldered there. Each trail has a
  set of **solder joints**: the tool proposes the needed ones (at part legs, where trails
  meet, at the ends, plus an anchor on long runs; the anchor rule is the builder's call)
  and the owner can add or remove joints.
- **Insulated wires**: start hole, end hole, side, colour, and one of two kinds:
  - **laid** (the owner's default when possible): runs flat along rows and columns
    through bend points, like a trail. Gets the full wire card (cut, strip, 1:1 bend
    drawing). Where it runs counts for the checks (bodies, keep-away, crossings).
  - **flying**: a loose jumper between two holes. Gets cut and strip only; its length
    comes from the straight distance between ends plus slack (bench setting).
  A wire can be **mixed**: stretches along it are marked bare or insulated (for example
  5 mm bare, 95 mm insulated where it crosses another trail, 100 mm bare as a trail
  along a row). Wire ends land in a free hole, never in a hole that already holds a leg.
- **Leg-fold bridges**: a part leg left long and folded flat onto an adjacent hole on
  the solder side, then soldered at both. Stored as (leg, target hole).
- **Solder bridges**: a blob joining two adjacent holes, for the rare cases that need it.
- **Bench settings** (per board or global): wire end lead length (default 5 mm),
  bend allowance per bend (default 1 mm), spare length, flying-wire slack, rounding step. Editable.

The model must leave room for later versions without a rewrite: a schematic source
(KiCad / EasyEDA netlist with part references), per-part 3D model references, and
automatic placement / routing writing into the same structures.

## 4. Technical check

Runs on the wiring exactly as drawn. Ported from perfwire's rule engine
(`solver.py`: `erc_audit()`, `topology_audit()`; same logic in `index.html`
`ercAudit()`), written once in TypeScript.

From perfwire (these worked well and caught every planted error):

- Open nets: pins of a net that are not connected.
- Shorts: two nets connected together (by a trail, wire, bridge or shared hole).
- Unconnected legs, and driver contention (two outputs on one net).

New, from what channel board 1 taught us:

- **One leg per hole**: two leads, or a lead and a wire end, in the same hole is an error.
- **Body collisions**: part bodies overlapping each other, or a wire end, trail joint
  or leg placed under a body that covers it (screw terminals, relay, TO-220 tab).
- **Keep-away between net classes**, measured on everything carrying a net: pins,
  trails, joints, wire ends (not just part pins).
- **Adjacent-hole cautions in severity buckets**:
  - *Shorts the supply* (for example 12 V next to GND),
  - *Kills the MCU* (12 V next to a logic line),
  - *Harmless* (two logic lines, or neighbouring pins of the same part).
  The buckets come from the net classes in the board file.

Output: a list of findings, each with a severity, the holes involved and a plain
message, shown in the browser and printed by the command-line tool.

## 5. Browser editor and preview

- **Flat view, both sides.** Top and bottom are visible at the same time
  (side by side, or a one-key flip: builder's call, both must be fast). Part bodies at
  real size, trails and wires drawn where they really run, joints visibly different from
  holes a trail just passes over.
- **Hover a hole or pin** to see its name and net, and highlight the whole net.
- **Pencil tool** for trails, on the side being viewed:
  click a hole to start, each next click adds a straight stretch to that hole;
  clicking a hole that already has a trace, or the same hole twice, ends the trail
  (joining it to the trace it landed on).
- **Erase tool**: click one trail segment to remove just that segment (which can split a
  trail in two). Insulated wires are not affected by the erase tool.
- **Joint toggle**: click a hole on a trail to add or remove a solder joint.
- Findings from the check are listed and shown on the board; the check reruns after
  every edit.
- **Saving**: edits are written back to the board file. When Claude changes the file,
  the open page reloads it. Never silently restore an older version; show which version
  is loaded (for example a revision number or time saved).
- **3D view** for the final review: real-size simple bodies (boxes, cylinders, legs,
  pins), the board, trails and wires, both sides. Perfwire's 3D view is the quality bar
  ("fairly OK"). Better connector and header models are a nice-to-have in v1.
- English UI.

## 6. Bench export

Generated from the board file. Two forms, same content:

- **Print**, at true 1:1 scale, with a 10 mm scale bar on every scaled page so print
  scaling can be checked with a ruler.
- **One self-contained HTML file** that works offline on a phone or iPad (no server, no
  network), to replace the paper.

Content:

1. **Parts placement**: each part, its holes, orientation (pin 1, polarity, which way the
   tab or flat side faces), standing or lying, and the order to place them in.
2. **Wire cards**, one per trail or wire:
   - **Cut** length, with a small breakdown of where it comes from: path on board
     + bend allowance per bend + lead at each end + spare, rounded up.
   - **Strip** plan: a bar showing which stretches are bare and which insulated, with
     "strip at X mm" marks measured from the start.
   - **Bend** drawing at 1:1: the full shape, each segment's length, each bend numbered
     with angle and direction, start hole and end hole named, the side it goes on.
   - Material and colour, net and net class.
3. **Leg-fold bridges**: which leg, folded toward which hole, seen from the solder side.
4. **Meter test list** (before power): two probe points per line, expected
   **beep** or **no beep**, and why, with a checkbox. Must-not-beep lines grouped by the
   severity buckets of section 4.

The existing `light-ctrl/re/boards/build_sheet.py` / `build_sheet.html` is the starting
point for the content and look of these sheets.

## 7. Working with Claude

- A command-line tool, in the same TypeScript code as the editor, that Claude runs:
  check a board file and print the findings; generate the bench export.
- Claude edits the board file directly (placement, routing, applying the owner's paper
  notes) and runs the check; the browser shows the result.

## 8. Channel board 2

- A one-off import of the existing channel board 2 layout from light-ctrl
  (`re/boards/channel_board.py`, which writes `channel_board.json`, with the
  TC4426 gate driver, the U1 and JH rotations, the 7 x 1N4001 lift chains,
  the screw terminal blocked rows and the trails and insulated wires listed there).
  Trails become paths again (the source keeps them as paths before expanding them to
  bridges). The import can be a throwaway script.
- Done for v1 when: channel board 2 is in the new format, the check runs clean (or every
  finding is understood), the owner has approved it by looking at both sides and in 3D,
  and the bench sheets have been printed and used to build it.

## 9. How it gets made (Claude's calls)

- **A fresh project**, not a fork of perfwire. It reuses perfwire's ideas and ports its
  rule engine logic. Perfwire is Apache-2.0: keep its license notice and credit it on
  anything ported. The perfwire clone stays alongside as reference only.
- **Nuxt + Nuxt UI** for the editor (the owner already uses it; hot reload).
  Runs locally with `npm run dev`. No hosting needed.
- **One TypeScript core** (board model, footprint library, check, bench length maths)
  used by the editor, the command-line tool and the export. Unit tests on the core;
  perfwire's planted-error cases and channel board 1 / 2 as test boards.
- **3D** with three.js via TresJS.
- **Board file** in the project folder; the Nuxt dev server watches it and pushes changes
  to the page.
- **Bench export**: a self-contained HTML file (inline styles and drawings, SVG in mm
  for 1:1 print).
- **Open source** licence: builder's call, Apache-2.0 suggested (matches perfwire).

## 9b. Calls made after review (Claude's)

- **Contact rule for trails** (physical reality on a perfboard): a bare trail passing
  over a hole that holds a leg or any solder *on the same side* touches it. Same net: that hole must get a
  joint (the tool adds it). Other net: error (short). Passing over an empty, unsoldered
  hole makes no contact.
- **Test boards**: channel board 2 plus re-planted error cases (a trail one hole short,
  a trail into the wrong pin, swapped inputs, two legs in one hole, 12 V next to a logic
  line). Channel board 1 as built is not reconstructed.
- **Conflicts**: if the file changed on disk while the page has unsaved edits, the page
  says so and asks; it never overwrites either side silently.

## 10. Left to the builder

- Exact file format and folder layout.
- Side-by-side vs flip for the two sides, as long as both are quick.
- Anchor joint rule for long trails.
- How the check's findings are shown on the board.
- Exact visual design, following the existing build sheet's look where it fits.

## 11. Build order (decided by the owner)

1. **Preview / editor first** (with the board model, the check, the command-line check
   and the channel board 2 import underneath it). The owner plays with board 2 on screen
   before building it; board 2 waits for this.
2. **Bench export** next: printed 1:1 sheets and the offline HTML file.
3. **3D view** last.

## 12. Where things live

- **Board files belong to their hardware project in the end**: channel board 2's file
  will live in light-ctrl (`re/boards/`). The tool opens a board file by path, from
  anywhere, and watches that file for live reload.
- The tool's repo keeps **a local copy of channel board 2** as demo / dev / test data.
- The project lives in `/Users/stakabo/Work/repos/BH/perfwire` (folder name kept for
  now); the perfwire upstream clone is in `reference/perfwire-upstream/` (gitignored,
  read-only reference).
- **Name: WireBender.** The icon is original pixel art (a small robot head on a
  perfboard grid with a bent-wire antenna), not Bender or any Futurama artwork:
  that character is copyrighted and must not ship in an open-source repo.
